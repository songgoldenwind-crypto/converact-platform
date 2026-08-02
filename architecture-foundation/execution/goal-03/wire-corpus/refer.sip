REFER sip:bob@uas.example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKfreeze002;rport
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=from-freeze
To: <sip:bob@example.invalid>;tag=to-freeze
Call-ID: wire-freeze-call@example.invalid
Contact: <sip:alice@edge.example.invalid:5060>
CSeq: 5 REFER
Refer-To: <sip:carol@example.invalid>
Referred-By: <sip:alice@example.invalid>
Content-Length: 0

