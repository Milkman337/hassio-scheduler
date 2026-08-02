"""WebSocket API for the global pause ("master switch") flag."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_global_state"})
@websocket_api.async_response
async def ws_get_global_state(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    store = hass.data[DOMAIN]["global_store"]
    connection.send_result(msg["id"], {"paused": store.paused})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/set_paused", vol.Required("paused"): bool}
)
@websocket_api.async_response
async def ws_set_paused(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["global_store"]
    await store.async_set_paused(msg["paused"])
    connection.send_result(msg["id"], {"paused": store.paused})


COMMAND_HANDLERS = (ws_get_global_state, ws_set_paused)


def async_register_global_websocket_commands(hass: HomeAssistant) -> None:
    for handler in COMMAND_HANDLERS:
        websocket_api.async_register_command(hass, handler)
