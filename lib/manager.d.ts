import { Manager as RootManager, ManagerOptions as RootManagerOptions } from "socket.io-client";
import { SocketOptions, Socket } from "./rtc";
export type ManagerOptions = RootManagerOptions;
export declare class Manager extends RootManager {
    constructor(uri: string, opts?: Partial<ManagerOptions & SocketOptions>);
    socket(nsp: string, opts?: Partial<SocketOptions>): Socket;
}
