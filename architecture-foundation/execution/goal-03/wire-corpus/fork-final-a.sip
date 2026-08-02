SIP/2.0 200 OK
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>;tag=fork-a
Call-ID: wire-freeze-call@example.invalid
CSeq: 1 INVITE
Contact: <sip:bob@fork-a.example.invalid>
Content-Length: 0

