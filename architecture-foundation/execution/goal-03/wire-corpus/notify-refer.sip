NOTIFY sip:alice@edge.example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze002;rport
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>;tag=to-freeze
Call-ID: wire-freeze-call@example.invalid
Contact: <sip:alice@edge.example.invalid:5060>
CSeq: 1 NOTIFY
Event: refer
Subscription-State: terminated;reason=noresource
Content-Type: message/sipfrag
Content-Length: 16

SIP/2.0 200 OK
