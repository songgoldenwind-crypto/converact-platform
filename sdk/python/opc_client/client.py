"""Deprecated compatibility shim for the pre-Converact Python SDK import.

Remove with Converact Python SDK 1.0.0 after consumers migrate to
``converact_client.client.ConveractClient``.
"""

from converact_client.client import ConveractClient

OpcClient = ConveractClient

__all__ = ["OpcClient"]
