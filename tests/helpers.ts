import { createServer } from 'http';
import { Server } from 'socket.io';
import { RtcioEvents } from '../lib/events';
import type { AddressInfo } from 'net';

export interface TestServer {
	port: number;
	close(): Promise<void>;
}

/**
 * In-process socket.io server that implements the minimal room protocol:
 * - join-room              → broadcasts RtcioEvents.INIT_OFFER to all existing room members
 * - RtcioEvents.MESSAGE → forwarded to the named target peer
 */
export async function createTestServer(): Promise<TestServer> {
	const http = createServer();
	const io   = new Server(http, { transports: ['websocket'], cors: { origin: '*' } });
	const rooms = new Map<string, Set<string>>();

	io.on('connection', (socket) => {
		socket.on('join-room', ({ roomId }: { roomId: string }) => {
			const room = rooms.get(roomId) ?? new Set<string>();
			// Tell every existing peer to initiate a connection towards the newcomer.
			room.forEach((peerId) => {
				io.to(peerId).emit(RtcioEvents.INIT_OFFER, {
					source: socket.id,
					target: peerId,
					data:   {},
				});
			});
			room.add(socket.id!);
			rooms.set(roomId, room);
			socket.join(roomId);
		});

		socket.on(RtcioEvents.MESSAGE, (payload: { target: string }) => {
			io.to(payload.target).emit(RtcioEvents.MESSAGE, payload);
		});

		socket.on('disconnect', () => {
			rooms.forEach((r) => r.delete(socket.id!));
		});
	});

	return new Promise((resolve) => {
		http.listen(0, '127.0.0.1', () => {
			const { port } = http.address() as AddressInfo;
			resolve({
				port,
				close: () =>
					new Promise<void>((res) => {
						io.close();
						http.close(() => res());
					}),
			});
		});
	});
}

export function waitForEvent<T = unknown>(emitter: any, event: string, timeout = 3000): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`Timeout waiting for "${event}"`)),
			timeout,
		);
		emitter.once(event, (data: T) => { clearTimeout(t); resolve(data); });
	});
}
