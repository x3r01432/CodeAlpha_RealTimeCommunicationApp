// ICE servers handed to browsers. Google's public STUN servers handle most NATs;
// add a TURN server (e.g. coturn) via TURN_URL / TURN_USERNAME / TURN_CREDENTIAL for strict corporate networks.
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  return list;
}
const MAX_PEERS = Number(process.env.MAX_PEERS || 6); // mesh topology: keep rooms small
module.exports = { iceServers, MAX_PEERS };
