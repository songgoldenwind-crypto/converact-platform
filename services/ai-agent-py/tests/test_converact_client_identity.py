import unittest


class ConveractClientIdentityTests(unittest.TestCase):
    def test_converact_client_is_authoritative_and_legacy_name_is_one_alias(self):
        from converact_client import ConveractClient
        from converact_client import OPCClient

        self.assertIs(OPCClient, ConveractClient)


if __name__ == "__main__":
    unittest.main()
