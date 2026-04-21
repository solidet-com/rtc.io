import { describe, it, expect, vi } from 'vitest';
import { RTCIOStream } from '../lib/stream';
import { MockMediaStream, MockMediaStreamTrack } from './mocks';

// Convenience factories
const ms    = () => new MockMediaStream() as unknown as MediaStream;
const track = (kind: 'audio' | 'video' = 'video') =>
	new MockMediaStreamTrack(kind) as unknown as MediaStreamTrack;

describe('RTCIOStream', () => {

	describe('construction', () => {
		it('auto-generates a uuid when given only a MediaStream', () => {
			const stream = new RTCIOStream(ms());
			expect(stream.id).toMatch(/^[0-9a-f-]{36}$/i);
		});

		it('preserves an explicit id', () => {
			const stream = new RTCIOStream('my-id', ms());
			expect(stream.id).toBe('my-id');
		});

		it('two instances wrapping the same MediaStream get different ids', () => {
			const m = ms();
			expect(new RTCIOStream(m).id).not.toBe(new RTCIOStream(m).id);
		});

		it('exposes the underlying MediaStream', () => {
			const m = ms();
			expect(new RTCIOStream(m).mediaStream).toBe(m);
		});
	});

	describe('addTrack', () => {
		it('returns the stream instance (chainable)', () => {
			const stream = new RTCIOStream(ms());
			expect(stream.addTrack(track())).toBe(stream);
		});

		it('fires all onTrackChanged callbacks', () => {
			const m = ms();
			const stream = new RTCIOStream(m);
			const cb1 = vi.fn();
			const cb2 = vi.fn();
			stream.onTrackChanged(cb1);
			stream.onTrackChanged(cb2);
			stream.addTrack(track());
			expect(cb1).toHaveBeenCalledOnce();
			expect(cb2).toHaveBeenCalledOnce();
			expect(cb1).toHaveBeenCalledWith(m);
		});
	});

	describe('removeTrack', () => {
		it('fires onTrackChanged callback', () => {
			const t = track('audio');
			const m = new MockMediaStream([t as unknown as MockMediaStreamTrack]) as unknown as MediaStream;
			const stream = new RTCIOStream(m);
			const cb = vi.fn();
			stream.onTrackChanged(cb);
			stream.removeTrack(t);
			expect(cb).toHaveBeenCalledOnce();
		});

		it('returns the stream instance (chainable)', () => {
			const t = track();
			const m = new MockMediaStream([t as unknown as MockMediaStreamTrack]) as unknown as MediaStream;
			const stream = new RTCIOStream(m);
			expect(stream.removeTrack(t)).toBe(stream);
		});
	});

	describe('onTrackChanged unsubscribe', () => {
		it('stops firing after calling the returned cleanup function', () => {
			const stream = new RTCIOStream(ms());
			const cb = vi.fn();
			const unsub = stream.onTrackChanged(cb);
			unsub();
			stream.addTrack(track());
			expect(cb).not.toHaveBeenCalled();
		});

		it('removing one subscriber does not remove others', () => {
			const stream = new RTCIOStream(ms());
			const cb1 = vi.fn();
			const cb2 = vi.fn();
			const unsub1 = stream.onTrackChanged(cb1);
			stream.onTrackChanged(cb2);
			unsub1();
			stream.addTrack(track());
			expect(cb1).not.toHaveBeenCalled();
			expect(cb2).toHaveBeenCalledOnce();
		});
	});

	describe('replace', () => {
		it('swaps all tracks in the underlying MediaStream', () => {
			const old = track('video');
			const m   = new MockMediaStream([old as unknown as MockMediaStreamTrack]) as unknown as MediaStream;
			const stream = new RTCIOStream(m);

			const fresh = track('video');
			const newMs = new MockMediaStream([fresh as unknown as MockMediaStreamTrack]) as unknown as MediaStream;
			stream.replace(newMs);

			expect(m.getTracks()).toContain(fresh);
			expect(m.getTracks()).not.toContain(old);
		});
	});

	describe('toJSON', () => {
		it('returns the expected token format', () => {
			expect(new RTCIOStream('abc-123', ms()).toJSON()).toBe('[RTCIOStream] abc-123');
		});
	});

});
