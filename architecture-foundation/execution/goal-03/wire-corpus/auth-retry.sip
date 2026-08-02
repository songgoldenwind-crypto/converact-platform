INVITE sip:bob@example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze-auth;rport
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>
Call-ID: wire-freeze-call@example.invalid
CSeq: 2 INVITE
Contact: <sip:alice@edge.example.invalid:5060>
Authorization: Digest username="alice",realm="example.invalid",nonce="test-only",uri="sip:bob@example.invalid",response="00000000000000000000000000000000",algorithm=SHA-256,qop=auth,nc=00000001,cnonce="test-only"
Content-Length: 0

