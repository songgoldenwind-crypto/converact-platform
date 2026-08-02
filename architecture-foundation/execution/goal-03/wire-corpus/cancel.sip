CANCEL sip:bob@example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze001;rport
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>
Call-ID: wire-freeze-call@example.invalid
CSeq: 1 CANCEL
Content-Length: 0

