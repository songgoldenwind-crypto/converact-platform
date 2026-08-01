"""Deprecated import shim for the pre-Converact client name.

Remove with Converact Agent Runtime 1.0.0 after callers migrate to
``converact_client.ConveractClient``.
"""

from converact_client import ConveractClient

OPCClient = ConveractClient

__all__ = ["OPCClient"]
