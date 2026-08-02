INVITE sip:bob@example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>
Call-ID: wire-freeze-call@example.invalid
CSeq: 1 INVITE
Contact: <sip:alice@edge.example.invalid:5060>
Content-Type: application/sdp
Content-Length: 228

v=0
o=alice 1 1 IN IP4 192.0.2.10
s=Converact wire freeze
c=IN IP4 192.0.2.10
t=0 0
m=audio 40000 RTP/AVP 0 8 101
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-16
a=sendrecv
