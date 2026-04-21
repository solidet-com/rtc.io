import { vi } from 'vitest';
import { MockRTCPeerConnection, MockMediaStream, MockMediaStreamTrack } from './mocks';

vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
vi.stubGlobal('MediaStream', MockMediaStream);
vi.stubGlobal('MediaStreamTrack', MockMediaStreamTrack);
