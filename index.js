#! /usr/bin/env node

'use strict';

var _ = require('lodash');
var tls = require('tls');
var net = require('net');
var eos = require('end-of-stream');
var through = require('through2');
var minimist = require('minimist');
var allContainers = require('docker-allcontainers');
var statsFactory = require('docker-stats');
var logFactory = require('docker-loghose');
var eventsFactory = require('docker-event-log');
var os = require('os');

function connect(opts) {
  var stream;
  if (opts.secure) {
    stream = tls.connect(opts.port, opts.server, onSecure);
  } else {
    stream = net.createConnection(opts.port, opts.server);
  }

  function onSecure() {
    // let's just crash if we are not secure
    if (!stream.authorized) throw new Error('secure connection not authorized');
  }

  return stream;
}


function start(opts) {
  var logsToken = opts.logstoken || opts.token;
  var statsToken = opts.statstoken || opts.token;
  var eventsToken = opts.eventstoken || opts.token;
  var out;
  var noRestart = function() {};
  var imageNameMap = {};
  var nameLabelMap = {};
  var logLabelCompiledTempate = _.template(opts.logLabelTemplate);
  var logLabelRegExp = new RegExp(opts.logLabelRegExp, "i");

  function getTokenWithRouter (imageName, fallback) {
    var rule = opts.tokenByMatch.find(function (rule) {
      return rule.imageNameMatch.test(imageName);
    });

    imageNameMap[imageName] = rule ? rule.token : fallback;

    return imageNameMap[imageName];
  }

  function getNameLabel(containerName) {
    if (logLabelRegExp.test(containerName)) {
      var m = logLabelRegExp.exec(containerName);
      nameLabelMap[containerName] = logLabelCompiledTempate({m});
    } else {
      nameLabelMap[containerName] = containerName;
    }

    return nameLabelMap[containerName];
  }

  var filter = through.obj(function(obj, enc, cb) {
    addAll(opts.add, obj);
    var token = '';
    var log = '';

    if (obj.line) {
      token = imageNameMap[obj.image] || getTokenWithRouter(obj.image, logsToken);
      var label = nameLabelMap[obj.name] || getNameLabel(obj.name);

      log = `${new Date(obj.time).toISOString()} ${label} ${obj.line}`;
    }
    else if (obj.type) {
      token = eventsToken;
      log = JSON.stringify(obj);
    }
    else if (obj.stats) {
      token = statsToken;
      log = JSON.stringify(obj);
    }

    if (token) {
      this.push(token);
      this.push(' ');
      this.push(log);
      this.push('\n');
    }

    cb()
  });

  var events = allContainers(opts);
  var loghose;
  var stats;
  var dockerEvents;
  var streamsOpened = 0;

  opts.events = events;

  if (opts.logs !== false && (logsToken || _.size(opts.tokenByMatch) > 0)) {
    loghose = logFactory(opts);
    loghose.pipe(filter);
    streamsOpened++;
  }

  if (opts.stats !== false && statsToken) {
    stats = statsFactory(opts);
    stats.pipe(filter);
    streamsOpened++;
  }

  if (opts.dockerEvents !== false && eventsToken) {
    dockerEvents = eventsFactory(opts);
    dockerEvents.pipe(filter);
    streamsOpened++;
  }

  if (!stats && !loghose && !dockerEvents) {
    throw new Error('you should enable at least one of stats, logs or dockerEvents');
  }

  pipe();

  // destroy out if all streams are destroyed
  loghose && eos(loghose, function() {
    streamsOpened--;
    streamClosed(streamsOpened);
  });
  stats && eos(stats, function() {
    streamsOpened--;
    streamClosed(streamsOpened);
  });
  dockerEvents && eos(dockerEvents, function() {
    streamsOpened--;
    streamClosed(streamsOpened);
  });

  return loghose;

  function addAll(proto, obj) {
    if (!proto) { return; }

    var key;
    for (key in proto) {
      if (proto.hasOwnProperty(key)) {
        obj[key] = proto[key];
      }
    }
  }

  function pipe() {
    if (out) {
      filter.unpipe(out);
    }

    out = connect(opts);

    filter.pipe(out, { end: false });

    // automatically reconnect on socket failure
    noRestart = eos(out, pipe);
  }

  function streamClosed(streamsOpened) {
    if (streamsOpened <= 0) {
      noRestart()
      out.destroy();
    }
  }
}

var unbound;

function cli() {
  var argv = minimist(process.argv.slice(2), {
    boolean: ['json', 'secure', 'stats', 'logs', 'dockerEvents'],
    string: ['tokenByMatch', 'token', 'logstoken', 'statstoken', 'eventstoken', 'server', 'port'],
    alias: {
      'tokenByMatch': 'r',
      'token': 't',
      'logstoken': 'l',
      'newline': 'n',
      'statstoken': 'k',
      'eventstoken': 'e',
      'secure': 's',
      'json': 'j',
      'statsinterval': 'i',
      'add': 'a'
    },
    default: {
      tokenByMatch: [],
      json: false,
      newline: true,
      stats: true,
      logs: true,
      dockerEvents: true,
      statsinterval: 30,
      add: [], // [ 'host=' + os.hostname() ],
      logLabelTemplate: "<%= m[0] %>",
      logLabelRegexp: null,
      token: process.env.LOGENTRIES_TOKEN,
      logstoken: process.env.LOGENTRIES_LOGSTOKEN || process.env.LOGENTRIES_TOKEN,
      statstoken: process.env.LOGENTRIES_STATSTOKEN || process.env.LOGENTRIES_TOKEN,
      eventstoken: process.env.LOGENTRIES_EVENTSTOKEN || process.env.LOGENTRIES_TOKEN,
      server: 'data.logentries.com',
      port: unbound
    }
  });

  if (argv.help || !(argv.token || argv.logstoken || argv.statstoken || argv.eventstoken)) {
    console.log('Usage: docker-logentries [-l LOGSTOKEN] [-k STATSTOKEN] [-e EVENTSTOKEN]\n' +
                '                         [-t TOKEN] [--secure] [--json]\n' +
                '                         [--no-newline] [--no-stats] [--no-logs] [--no-dockerEvents]\n' +
                '                         [-i STATSINTERVAL] [-a KEY=VALUE]\n' +
                '                         [--matchByImage REGEXP] [--matchByName REGEXP]\n' +
                '                         [--skipByImage REGEXP] [--skipByName REGEXP]\n' +
                '                         [--server HOSTNAME] [--port PORT]\n' +
                '                         [-r IMAGE_NAME_REGEX1=TOKEN1 -r IMAGE_NAME_REGEX2=TOKEN2]\n' +
                '                         [--help]');

    process.exit(1);
  }

  if (argv.port == unbound) {
    if (argv.secure) {
      argv.port = 443;
    } else {
      argv.port = 80;
    }
  } else {
      argv.port = parseInt(argv.port);
      // TODO: support service names
      if (isNaN(argv.port)) {
        console.log('port must be a number');
        process.exit(1);
      }
  }

  if (argv.add && !Array.isArray(argv.add)) {
    argv.add = [argv.add];
  }

  argv.add = argv.add.reduce(function(acc, arg) {
    arg = arg.split('=');
    acc[arg[0]] = arg[1];
    return acc
  }, {});

  if (argv.tokenByMatch && !Array.isArray(argv.tokenByMatch)) {
    argv.tokenByMatch = [argv.tokenByMatch];
  }

  argv.tokenByMatch = argv.tokenByMatch.reduce(function(acc, arg) {
    arg = arg.split('=');

    acc.push({imageNameMatch: new RegExp(arg[0]), token: arg[1]});
    return acc
  }, []);

  start(argv);
}

module.exports = start;

if (require.main === module) {
  cli();
}
