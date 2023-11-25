let video1 = document.getElementById('video1');

// Function to get the value of a query parameter from the URL
function getQueryParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// Extracting the room name from the URL
const roomName = getQueryParam('room');

let remoteStream = new MediaStream();
video1.srcObject = remoteStream;

const servers = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302"],
    },
  ],
};
let pc = new RTCPeerConnection(servers);
pc.addTransceiver('video', { 'direction': 'recvonly' });
pc.addTransceiver('audio', { 'direction': 'recvonly' });

const offer = pc.createOffer().then(offer => {
  pc.setLocalDescription(offer);
const remoteServer=`http://35.158.121.45/${roomName}`
const localServer=`http://127.0.0.1:8080/${roomName}`
  console.log('Local SDP:', offer.sdp);

  fetch(remoteServer, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${roomName}`,
        'Content-Type': 'application/sdp'
      },
      body: offer.sdp
  })
  .then(response => {
      return response.json();
  })
  .then(response => {
    console.log('Remote SDP:', response.answer);

      pc.setRemoteDescription({
          sdp: response.answer,
          type: 'answer'
      });
      return response;
  }).then(r=>{
  
    fetch(`${r.location}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${roomName}`,
            'Content-Type': 'application/sdp'
        },
        body: pc.localDescription.sdp
    })
  }).catch(error => {
      console.error('Fetch error:', error);
  });
  
})



pc.addEventListener('iceconnectionstatechange', (event) => {
  if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
    console.log('Peer connection established.');
    if (pc.iceConnectionState === 'failed') {
      console.log("something failed")
      pc.restartIce()
    }
    // Play the video when the connection is established
  }
  console.log("SOMETING REGARDIN ICE HAPPENED")
  console.log(event)
});

pc.onerror = (event) => {
  console.error('WebRTC error:', event);
};
pc.ontrack = (event) => {
  console.log("event geldii")
  console.log(event.track.kind)

  event.streams[0].getTracks().forEach((track) => {
    console.log(track)

    // Log track events
    track.onended = () => {
      console.log('Video track ended:', track);
      // Add any handling or cleanup logic here
    };

    track.onmute = () => {
      console.log('Video track muted:', track);
      // Add any handling or cleanup logic here
    };

    // Check if the track is added or removed
    if (event.track.readyState === 'ended') {
      console.log('Video track ended:', track);
      // Add any handling or cleanup logic here
    } else {
      remoteStream.addTrack(track);
      console.log('Video SourceObject:', video1.srcObject);
    }
  });
};





/*
document.getElementById('playButton').addEventListener('click', () => {
  video1.play()
    .then(() => {
      console.log('Video playback started successfully.');
    })
    .catch(error => {
      console.error('Error starting video playback:', error);
    });
});
*/
