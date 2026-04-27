import { url } from "./lib/url";
import { Socket } from "./lib/rtc";
import { Manager } from "./lib/manager";
import { RTCIOStream } from "./lib/stream";
import { RTCIOChannel } from "./lib/channel";
import { RTCIOBroadcastChannel } from "./lib/broadcast-channel";
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
    const parsed = url(uri, opts.path || "/socket.io");
    const source = parsed.source;
    const id = parsed.id;
    const path = parsed.path;
    const sameNamespace = cache[id] && path in cache[id]["nsps"];
    const newConnection = opts.forceNew || false === opts.multiplex || sameNamespace;
    let io;
    if (newConnection) {
        io = new Manager(source, opts);
    }
    else {
        if (!cache[id]) {
            cache[id] = new Manager(source, opts);
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
    Manager,
    Socket,
    io: lookup,
    connect: lookup,
});
/**
 * Protocol version.
 *
 * @public
 */
export { protocol } from "socket.io-parser";
/**
 * Expose constructors for standalone build.
 *
 * @public
 */
export { RtcioEvents } from "./lib/events";
export { RTCIOStream, RTCIOChannel, RTCIOBroadcastChannel, Manager, Socket, lookup as io, lookup as connect, lookup as default, };
