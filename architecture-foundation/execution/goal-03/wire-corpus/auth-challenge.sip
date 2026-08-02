SIP/2.0 401 Unauthorized
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>;tag=auth-freeze
Call-ID: wire-freeze-call@example.invalid
CSeq: 1 INVITE
WWW-Authenticate: Digest realm="example.invalid",nonce="test-only",algorithm=SHA-256,qop="auth"
Content-Length: 0

