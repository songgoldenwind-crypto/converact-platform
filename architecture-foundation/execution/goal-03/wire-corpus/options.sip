OPTIONS sip:service@example.invalid SIP/2.0
Via: SIP/2.0/UDP edge.example.invalid:5060;branch=z9hG4bKopt001
Max-Forwards: 70
From: <sip:probe@example.invalid>;tag=probe-freeze
To: <sip:service@example.invalid>
Call-ID: options-freeze@example.invalid
CSeq: 1 OPTIONS
Content-Length: 0

