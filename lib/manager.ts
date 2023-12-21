import {
	Manager as RootManager,
	ManagerOptions as RootManagerOptions,
} from "socket.io-client";
import { SocketOptions, Socket } from "./rtc";

export type ManagerOptions = RootManagerOptions;

export class Manager extends RootManager {
	constructor(uri: string, opts?: Partial<ManagerOptions & SocketOptions>) {
		super(uri, opts);
	}

	socket(nsp: string, opts?: Partial<SocketOptions>): Socket {
		return new Socket(this as any, nsp, opts);
	}
}
