REGISTER sip:example.invalid SIP/2.0
Via: SIP/2.0/TCP ua.example.invalid:5060;branch=z9hG4bKreg001
Max-Forwards: 70
From: <sip:alice@example.invalid>;tag=register-freeze
To: <sip:alice@example.invalid>
Call-ID: register-freeze@example.invalid
CSeq: 1 REGISTER
Contact: <sip:alice@ua.example.invalid:5060>;expires=300
Content-Length: 0

