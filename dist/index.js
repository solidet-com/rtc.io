"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOStream = exports.Socket = exports.Manager = exports.protocol = void 0;
exports.io = lookup;
exports.connect = lookup;
exports.default = lookup;
const url_1 = require("./lib/url");
const rtc_1 = require("./lib/rtc");
Object.defineProperty(exports, "Socket", { enumerable: true, get: function () { return rtc_1.Socket; } });
const manager_1 = require("./lib/manager");
Object.defineProperty(exports, "Manager", { enumerable: true, get: function () { return manager_1.Manager; } });
const stream_1 = __importDefault(require("./lib/stream"));
exports.RTCIOStream = stream_1.default;
/**
 * Managers cache.
 */
const cache = {};
function lookup(uri, opts) {
    if (typeof uri === "object") {
        opts = uri;
        uri = undefined;
    }
    opts = opts || {};
    const parsed = (0, url_1.url)(uri, opts.path || "/socket.io");
    const source = parsed.source;
    const id = parsed.id;
    const path = parsed.path;
    const sameNamespace = cache[id] && path in cache[id]["nsps"];
    const newConnection = opts.forceNew || false === opts.multiplex || sameNamespace;
    let io;
    if (newConnection) {
        io = new manager_1.Manager(source, opts);
    }
    else {
        if (!cache[id]) {
            cache[id] = new manager_1.Manager(source, opts);
        }
        io = cache[id];
    }
    if (parsed.query && !opts.query) {
        opts.query = parsed.queryKey;
    }
    return io.socket(parsed.path, opts);
}
// so that "lookup" can be used both as a function (e.g. `io(...)`) and as a
// namespace (e.g. `io.connect(...)`), for backward compatibility
Object.assign(lookup, {
    Manager: manager_1.Manager,
    Socket: rtc_1.Socket,
    io: lookup,
    connect: lookup,
});
/**
 * Protocol version.
 *
 * @public
 */
var socket_io_parser_1 = require("socket.io-parser");
Object.defineProperty(exports, "protocol", { enumerable: true, get: function () { return socket_io_parser_1.protocol; } });
