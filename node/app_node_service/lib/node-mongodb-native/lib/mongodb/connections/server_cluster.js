var Connection = require('../connection').Connection,
  DbCommand = require('../commands/db_command').DbCommand,
  MongoReply = require('../responses/mongo_reply').MongoReply,
  Server = require('./server').Server,
  debug = require('util').debug,
  inspect = require('util').inspect;

// Server cluster (one master and multiple read slaves)
var ServerCluster = exports.ServerCluster = function(servers) {
  // Containst the master server entry
  this.master = null;
  this.target = null;

  if(servers.constructor != Array || servers.length == 0) {
    throw Error("The parameter must be an array of servers and contain at least one server");
  } else if(servers.constructor == Array || servers.length > 0) {
    var count = 0;
    servers.forEach(function(server) {
      if(server instanceof Server) count = count + 1;
    });

    if(count < servers.length) {
      throw Error("All server entries must be of type Server");
    } else {
      this.servers = servers;
    }
  }
  // Setters and getters
  this.__defineGetter__("autoReconnect", function() {
    if(this.target != null) return this.target.autoReconnect;
    if(this.primary != null) return this.primary.autoReconnect;
  });
  this.__defineGetter__("primary", function() {
    // Allow overriding to a specific connection
    if(this.target != null && this.target instanceof Server) {
      return this.target.primary;
    } else {
      var finalServer = null;
      this.servers.forEach(function(server) {
        if(server.master == true) finalServer = server;
      });
      return finalServer != null ? finalServer.primary : finalServer;
    }
  });
};

ServerCluster.prototype.setTarget = function(target) {
  this.target = target;
};

ServerCluster.prototype.connect = function(parent, callback) {
  var serverConnections = this.servers;
  var numberOfCheckedServers = 0;

  serverConnections.forEach(function(server) {
    server.connection = new Connection(server.host, server.port, server.autoReconnect);

    var handleServerConnection = function(srv, connected) {
      numberOfCheckedServers+=1;
      // Set connected status
      server.connected = connected;

      if(numberOfCheckedServers == serverConnections.length) {
          if(parent.primary) {
              // emit a message saying we got a master and are ready to go and change state to reflect it
              parent.state = 'connected';
              callback(null, parent);
          } else {
              // emit error only when all servers are checked and connecting to them failed.
              parent.state = "notConnected"
              callback(new Error("Failed connecting to any of the servers in the cluster"), null);
          }
      }
    }

    server.connection.on("connect", function() {
      // Create a callback function for a given connection
      var connectCallback = function(err, reply) {
        if(err != null) return callback(err, null);

        server.master = reply.documents[0].ismaster == 1 ? true : false;
        handleServerConnection(server, true);
      };
      // Create db command and Add the callback to the list of callbacks by the request id (mapping outgoing messages to correct callbacks)
      var db_command = DbCommand.createIsMasterCommand(parent);
      // Add listener
      parent.on(db_command.getRequestId().toString(), connectCallback);
      // Let's send a request to identify the state of the server
      this.send(db_command);
    });

    server.connection.on("data", function(message) {
      // Parse the data as a reply object
      var reply = new MongoReply(parent, message);
      // Emit error if there is one
      reply.responseHasError ? parent.emit(reply.responseTo.toString(), reply.documents[0], reply) : parent.emit(reply.responseTo.toString(), null, reply);
      // Remove the listener
      parent.removeListener(reply.responseTo.toString(), parent.listeners(reply.responseTo.toString())[0]);

    });

    server.connection.on("error", function(err) {
      handleServerConnection(server, false);
    });

    // Emit timeout and close events so the client using db can figure do proper error handling (emit contains the connection that triggered the event)
    server.connection.on("timeout", function() { parent.emit("timeout", this); });
    server.connection.on("close", function() { parent.emit("close", this); });
    // Open the connection
    server.connection.open();
  });
}

ServerCluster.prototype.close = function() {
  this.servers.forEach(function(server) {
    server.close();
  })
}