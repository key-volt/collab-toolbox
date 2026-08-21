"""The websocket handshake: token in the subprotocol header, authorization from the DB."""

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from app.tools.room import _bearer_token
from tests.conftest import bearer

REJECTED = (WebSocketDisconnect, WebSocketDenialResponse)


def test_the_bearer_subprotocol_is_parsed() -> None:
    offered, token = _bearer_token("collab.v1, bearer.abc.def")

    assert offered is True
    assert token == "abc.def"


def test_a_missing_token_means_no_protocol_offered() -> None:
    offered, token = _bearer_token("collab.v1")

    assert offered is True
    assert token is None


def _create_document(client: TestClient, token: str) -> str:
    response = client.post(
        "/api/documents", json={"tool": "paint", "title": "Board"}, headers=bearer(token)
    )
    doc_id = response.json()["id"]
    assert isinstance(doc_id, str)
    return doc_id


def test_a_connection_without_a_token_is_rejected(client: TestClient, member_token: str) -> None:
    doc_id = _create_document(client, member_token)

    with pytest.raises(REJECTED), client.websocket_connect(f"/ws/paint/{doc_id}"):
        pass


def test_a_connection_with_a_bad_token_is_rejected(client: TestClient, member_token: str) -> None:
    doc_id = _create_document(client, member_token)

    with (
        pytest.raises(REJECTED),
        client.websocket_connect(
            f"/ws/paint/{doc_id}", subprotocols=["collab.v1", "bearer.not-a-token"]
        ),
    ):
        pass


def test_a_connection_to_a_missing_document_is_rejected(
    client: TestClient, member_token: str
) -> None:
    with (
        pytest.raises(REJECTED),
        client.websocket_connect(
            "/ws/paint/nope", subprotocols=["collab.v1", f"bearer.{member_token}"]
        ),
    ):
        pass


def test_a_valid_connection_is_accepted_with_the_protocol(
    client: TestClient, member_token: str
) -> None:
    doc_id = _create_document(client, member_token)

    with client.websocket_connect(
        f"/ws/paint/{doc_id}", subprotocols=["collab.v1", f"bearer.{member_token}"]
    ) as connection:
        assert connection.accepted_subprotocol == "collab.v1"
