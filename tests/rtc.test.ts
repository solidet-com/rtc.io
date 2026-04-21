import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { io as rtcio, RTCIOStream } from '../index';
import { MockMediaStream, MockMediaStreamTrack, MockRTCPeerConnection } from './mocks';
import { createTestServer, waitForEvent, type TestServer } from './helpers';

// ─── Test server & URL ────────────────────────────────────────────────────────

let server: TestServer;
let url: string;

beforeAll(async () => {
	server = await createTestServer();
	url    = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.close());

// ─── Factories ────────────────────────────────────────────────────────────────

function makePeer(opts?: Record<string, unknown>) {
	return rtcio(url, {
		iceServers:  [{ urls: 'stun:stun.l.google.com:19302' }],
		transports:  ['websocket'],
		forceNew:    true,
		...opts,
	}) as any; // cast: tests reach private members via (peer as any)
}

async function joinRoom(roomId: string, opts?: Record<string, unknown>) {
	const p = makePeer(opts);
	await waitForEvent(p, 'connect');
	p.emit('join-room', { roomId });
	return p;
}

function mockCamera(video = true, audio = true): MockMediaStream {
	const tracks: MockMediaStreamTrack[] = [];
	if (video) tracks.push(new MockMediaStreamTrack('video'));
	if (audio) tracks.push(new MockMediaStreamTrack('audio'));
	return new MockMediaStream(tracks);
}

// ─── ICE configuration ────────────────────────────────────────────────────────

describe('ICE configuration', () => {
	it('uses the provided iceServers', async () => {
		const turn = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
		const p = makePeer({ iceServers: turn });
		await waitForEvent(p, 'connect');
		expect(p.servers.iceServers).toEqual(turn);
		p.disconnect();
	});

	it('falls back to Google STUN when iceServers is omitted', async () => {
		const p = makePeer({ iceServers: undefined });
		await waitForEvent(p, 'connect');
		// urls is an array of strings in the fallback config
		const urls = [p.servers.iceServers[0].urls].flat().join(',');
		expect(urls).toMatch(/stun\d*\.l\.google\.com/);
		p.disconnect();
	});

	it('falls back to Google STUN when iceServers is an empty array', async () => {
		const p = makePeer({ iceServers: [] });
		await waitForEvent(p, 'connect');
		const urls = [p.servers.iceServers[0].urls].flat().join(',');
		expect(urls).toMatch(/stun\d*\.l\.google\.com/);
		p.disconnect();
	});
});

// ─── streamEvents — merge fix ─────────────────────────────────────────────────

describe('streamEvents — multiple events per stream', () => {
	it('two emits for the same stream keep both event keys', async () => {
		const p = await joinRoom('room-merge');

		const stream = new RTCIOStream(mockCamera() as unknown as MediaStream);
		p.emit('facecam',     { user: 'alice', stream });
		p.emit('screen-share', { label: 'tab', stream });

		const entry = p.streamEvents[stream.id];
		expect(entry['facecam']).toBeDefined();
		expect(entry['screen-share']).toBeDefined();
		expect(entry['facecam'][0].user).toBe('alice');
		expect(entry['screen-share'][0].label).toBe('tab');

		p.disconnect();
	});

	it('payload is stored as an args array', async () => {
		const p = await joinRoom('room-args');

		const stream = new RTCIOStream(mockCamera() as unknown as MediaStream);
		p.emit('facecam', { user: 'bob', stream });

		const args = p.streamEvents[stream.id]['facecam'];
		expect(Array.isArray(args)).toBe(true);
		expect(args[0].user).toBe('bob');

		p.disconnect();
	});
});

// ─── serialize / deserialize ──────────────────────────────────────────────────

describe('serializeStreamEvent / deserializeStreamEvent', () => {
	let p: any;
	beforeAll(async () => { p = await joinRoom('room-serde'); });
	afterAll(() => p.disconnect());

	it('serializes an RTCIOStream to its token string', () => {
		const stream = new RTCIOStream('fixed-id', mockCamera() as unknown as MediaStream);
		expect(p.serializeStreamEvent(stream)).toBe('[RTCIOStream] fixed-id');
	});

	it('serializes a nested object, leaving primitives intact', () => {
		const stream = new RTCIOStream('s1', mockCamera() as unknown as MediaStream);
		const out = p.serializeStreamEvent({ user: 'alice', count: 3, stream });
		expect(out.user).toBe('alice');
		expect(out.count).toBe(3);
		expect(out.stream).toBe('[RTCIOStream] s1');
	});

	it('serializes an array containing a stream', () => {
		const stream = new RTCIOStream('s2', mockCamera() as unknown as MediaStream);
		const out = p.serializeStreamEvent([42, stream, 'x']);
		expect(out[0]).toBe(42);
		expect(out[1]).toBe('[RTCIOStream] s2');
		expect(out[2]).toBe('x');
	});

	it('deserializes a token back to the RTCIOStream and syncs the id', () => {
		const stream = new RTCIOStream('local-id', mockCamera() as unknown as MediaStream);
		const result = p.deserializeStreamEvent('[RTCIOStream] remote-id', stream);
		expect(result).toBe(stream);
		expect(stream.id).toBe('remote-id');
	});

	it('deserializes a nested payload, replacing tokens in-place', () => {
		const stream = new RTCIOStream('orig', mockCamera() as unknown as MediaStream);
		const payload = { user: 'bob', stream: stream.toJSON() };
		const result  = p.deserializeStreamEvent(payload, stream);
		expect(result.user).toBe('bob');
		expect(result.stream).toBe(stream);
	});
});

// ─── Custom event dispatch (unit-style, no real WebRTC track needed) ──────────
//
// handleCallServiceMessage is called directly with a pre-built `events` payload.
// A fake peer + stream are injected into internal state so no real signaling
// or track delivery is required.

describe('custom event dispatch', () => {
	let p: any;
	let fakePeerId: string;
	let rtcioStream: RTCIOStream;
	let mid: string;

	beforeAll(async () => {
		p = await joinRoom('room-dispatch');
		fakePeerId = 'fake-peer-001';

		const conn = new MockRTCPeerConnection();
		const ms   = mockCamera();
		rtcioStream = new RTCIOStream(ms.id, ms as unknown as MediaStream);
		mid = ms.id;

		p.rtcpeers[fakePeerId] = {
			connection:       conn,
			socketId:         fakePeerId,
			polite:           false,
			streams:          { [mid]: rtcioStream },
			streamTransceivers: {},
			connectionStatus: {
				makingOffer: false, ignoreOffer: false,
				isSettingRemoteAnswerPending: false,
				negotiationNeeded: false, negotiationInProgress: false,
			},
		};
	});

	afterAll(() => p.disconnect());

	it('fires a custom event with the correct payload fields', async () => {
		const received = new Promise<any>((resolve) => p.once('facecam', resolve));

		await p.handleCallServiceMessage({
			source: fakePeerId,
			target: p.id,
			data: {
				mid,
				events: { facecam: [{ user: 'alice', stream: rtcioStream.toJSON() }] },
			},
		});

		const data = await received;
		expect(data.user).toBe('alice');
		expect(data.stream).toBe(rtcioStream); // deserialized back to RTCIOStream
	});

	it('fires multiple events in a single dispatch', async () => {
		const facecam  = new Promise<any>((resolve) => p.once('facecam2', resolve));
		const metadata = new Promise<any>((resolve) => p.once('metadata', resolve));

		await p.handleCallServiceMessage({
			source: fakePeerId,
			target: p.id,
			data: {
				mid,
				events: {
					facecam2:  [{ user: 'bob',  stream: rtcioStream.toJSON() }],
					metadata:  [{ quality: '1080p', stream: rtcioStream.toJSON() }],
				},
			},
		});

		expect((await facecam).user).toBe('bob');
		expect((await metadata).quality).toBe('1080p');
	});

	it('custom payload fields are preserved end-to-end', async () => {
		const received = new Promise<any>((resolve) => p.once('room-event', resolve));

		await p.handleCallServiceMessage({
			source: fakePeerId,
			target: p.id,
			data: {
				mid,
				events: {
					'room-event': [{ role: 'host', badges: ['mod', 'vip'], stream: rtcioStream.toJSON() }],
				},
			},
		});

		const data = await received;
		expect(data.role).toBe('host');
		expect(data.badges).toEqual(['mod', 'vip']);
	});
});

// ─── 2-peer signaling ─────────────────────────────────────────────────────────

describe('2-peer signaling', () => {
	it('both peers create a peer connection to each other', async () => {
		const pA = await joinRoom('room-2p-connect');
		const pB = await joinRoom('room-2p-connect');

		await vi.waitFor(() => {
			expect(pA.rtcpeers[pB.id]).toBeDefined();
			expect(pB.rtcpeers[pA.id]).toBeDefined();
		}, { timeout: 4000 });

		pA.disconnect();
		pB.disconnect();
	});

	it('offer/answer completes — both connections reach stable state', async () => {
		const pA = await joinRoom('room-2p-stable');
		const pB = await joinRoom('room-2p-stable');

		await vi.waitFor(() => {
			const connA = pA.rtcpeers[pB.id]?.connection;
			const connB = pB.rtcpeers[pA.id]?.connection;
			expect(connA?.signalingState).toBe('stable');
			expect(connB?.signalingState).toBe('stable');
		}, { timeout: 4000 });

		pA.disconnect();
		pB.disconnect();
	});

	it('exactly one side is polite and one is impolite', async () => {
		const pA = await joinRoom('room-2p-roles');
		const pB = await joinRoom('room-2p-roles');

		await vi.waitFor(() => {
			expect(pA.rtcpeers[pB.id]).toBeDefined();
			expect(pB.rtcpeers[pA.id]).toBeDefined();
		}, { timeout: 4000 });

		const aViewOfB = pA.rtcpeers[pB.id].polite;
		const bViewOfA = pB.rtcpeers[pA.id].polite;
		expect(aViewOfB).not.toBe(bViewOfA); // exactly one polite

		pA.disconnect();
		pB.disconnect();
	});
});

// ─── 3-peer signaling ─────────────────────────────────────────────────────────

describe('3-peer signaling — full mesh', () => {
	it('each peer connects to every other peer (3 connections)', async () => {
		const pA = await joinRoom('room-3p');
		const pB = await joinRoom('room-3p');
		const pC = await joinRoom('room-3p');

		await vi.waitFor(() => {
			expect(pA.rtcpeers[pB.id]).toBeDefined();
			expect(pA.rtcpeers[pC.id]).toBeDefined();
			expect(pB.rtcpeers[pA.id]).toBeDefined();
			expect(pB.rtcpeers[pC.id]).toBeDefined();
			expect(pC.rtcpeers[pA.id]).toBeDefined();
			expect(pC.rtcpeers[pB.id]).toBeDefined();
		}, { timeout: 6000 });

		pA.disconnect();
		pB.disconnect();
		pC.disconnect();
	});
});

// ─── 4-peer signaling ─────────────────────────────────────────────────────────

describe('4-peer signaling — full mesh (6 pairs)', () => {
	it('all six peer pairs are connected', async () => {
		const peers = await Promise.all([
			joinRoom('room-4p'), joinRoom('room-4p'),
			joinRoom('room-4p'), joinRoom('room-4p'),
		]);
		const [pA, pB, pC, pD] = peers;

		await vi.waitFor(() => {
			const pairs = [
				[pA, pB], [pA, pC], [pA, pD],
				[pB, pC], [pB, pD],
				[pC, pD],
			] as const;
			for (const [x, y] of pairs) {
				expect(x.rtcpeers[y.id]).toBeDefined();
				expect(y.rtcpeers[x.id]).toBeDefined();
			}
		}, { timeout: 8000 });

		peers.forEach(p => p.disconnect());
	});
});

// ─── Camera / mic scenarios ───────────────────────────────────────────────────

describe('media scenarios', () => {

	it('camera + mic stream is registered in streamEvents', async () => {
		const p = await joinRoom('room-cam-mic');
		const stream = new RTCIOStream(mockCamera(true, true) as unknown as MediaStream);
		p.emit('facecam', { user: 'alice', stream });

		expect(p.streamEvents[stream.id]?.['facecam']).toBeDefined();
		p.disconnect();
	});

	it('audio-only (camera off) stream is registered', async () => {
		const p = await joinRoom('room-audio-only');
		const ms = mockCamera(false, true);
		const stream = new RTCIOStream(ms as unknown as MediaStream);
		p.emit('facecam', { user: 'no-cam', stream });

		expect(p.streamEvents[stream.id]?.['facecam']).toBeDefined();
		expect(ms.getVideoTracks()).toHaveLength(0);
		expect(ms.getAudioTracks()).toHaveLength(1);
		p.disconnect();
	});

	it('video-only (mic off) stream is registered', async () => {
		const p = await joinRoom('room-video-only');
		const ms = mockCamera(true, false);
		const stream = new RTCIOStream(ms as unknown as MediaStream);
		p.emit('facecam', { user: 'no-mic', stream });

		expect(p.streamEvents[stream.id]?.['facecam']).toBeDefined();
		expect(ms.getVideoTracks()).toHaveLength(1);
		expect(ms.getAudioTracks()).toHaveLength(0);
		p.disconnect();
	});

	it('empty stream (cam+mic off on entrance) gets a placeholder transceiver when a peer joins', async () => {
		const pA = await joinRoom('room-cam-off-enter');
		const emptyMs = mockCamera(false, false);
		const stream  = new RTCIOStream(emptyMs as unknown as MediaStream);
		pA.emit('facecam', { stream });

		const pB = await joinRoom('room-cam-off-enter');

		await vi.waitFor(() => {
			const peer = pA.rtcpeers[pB.id];
			expect(peer).toBeDefined();
			expect(peer.streamTransceivers[emptyMs.id]?.length).toBeGreaterThan(0);
		}, { timeout: 4000 });

		pA.disconnect();
		pB.disconnect();
	});

	it('turning the camera on after joining triggers renegotiation', async () => {
		const pA = await joinRoom('room-cam-later');
		const emptyMs = mockCamera(false, false);
		const stream  = new RTCIOStream(emptyMs as unknown as MediaStream);
		pA.emit('facecam', { stream });

		const pB = await joinRoom('room-cam-later');
		await vi.waitFor(() => expect(pA.rtcpeers[pB.id]).toBeDefined(), { timeout: 4000 });

		// Spy on onnegotiationneeded *after* the initial handshake is stable
		const conn = pA.rtcpeers[pB.id].connection as MockRTCPeerConnection;
		const spy  = vi.fn();
		conn.onnegotiationneeded = spy;

		// User turns camera on
		stream.addTrack(new MockMediaStreamTrack('video') as unknown as MediaStreamTrack);

		await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 2000 });

		pA.disconnect();
		pB.disconnect();
	});

	it('one peer with camera, one without — signaling completes for both', async () => {
		const pWithCam = await joinRoom('room-mixed-cam');
		const stream   = new RTCIOStream(mockCamera(true, true) as unknown as MediaStream);
		pWithCam.emit('facecam', { stream });

		const pNoCam = await joinRoom('room-mixed-cam');

		await vi.waitFor(() => {
			expect(pWithCam.rtcpeers[pNoCam.id]).toBeDefined();
			expect(pNoCam.rtcpeers[pWithCam.id]).toBeDefined();
		}, { timeout: 4000 });

		pWithCam.disconnect();
		pNoCam.disconnect();
	});
});
