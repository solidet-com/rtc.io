import { SocketOptions, Socket } from "./lib/rtc";
import { Manager, ManagerOptions } from "./lib/manager";
import { RTCIOStream } from "./lib/stream";
/**
 * Looks up an existing `Manager` for multiplexing.
 * If the user summons:
 *
 *   `io('http://localhost/a');`
 *   `io('http://localhost/b');`
 *
 * We reuse the existing instance based on same scheme/port/host,
 * and we initialize sockets for each namespace.
 *
 * @public
 */
declare function lookup(opts?: Partial<ManagerOptions & SocketOptions>): Socket;
declare function lookup(uri: string, opts?: Partial<ManagerOptions & SocketOptions>): Socket;
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
export { RTCIOStream, Manager, Socket, lookup as io, lookup as connect, lookup as default, };
