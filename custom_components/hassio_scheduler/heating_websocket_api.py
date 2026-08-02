"""WebSocket API for heating programs, used by the frontend Heating tab."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/heating_list"})
@websocket_api.async_response
async def ws_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    store = hass.data[DOMAIN]["heating_store"]
    result = []
    for program_id, program in store.programs.items():
        extra = coordinator.data.get(program_id, {}) if coordinator.data else {}
        result.append(
            {
                **program,
                "target_temperature": extra.get("target_temperature"),
                "source": extra.get("source"),
            }
        )
    connection.send_result(msg["id"], {"programs": result})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/heating_get", vol.Required("program_id"): str}
)
@websocket_api.async_response
async def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    program = store.async_get(msg["program_id"])
    if program is None:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    connection.send_result(msg["id"], {"program": program})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/heating_create", vol.Required("program"): dict}
)
@websocket_api.async_response
async def ws_create(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    program = await store.async_create(msg["program"])
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"program": program})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/heating_update",
        vol.Required("program_id"): str,
        vol.Required("program"): dict,
    }
)
@websocket_api.async_response
async def ws_update(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    try:
        program = await store.async_update(msg["program_id"], msg["program"])
    except KeyError:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"program": program})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/heating_delete", vol.Required("program_id"): str}
)
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    await store.async_delete(msg["program_id"])
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/heating_set_enabled",
        vol.Required("program_id"): str,
        vol.Required("enabled"): bool,
    }
)
@websocket_api.async_response
async def ws_set_enabled(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    program = await store.async_set_enabled(msg["program_id"], msg["enabled"])
    if program is None:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"program": program})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/heating_duplicate", vol.Required("program_id"): str}
)
@websocket_api.async_response
async def ws_duplicate(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["heating_store"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    original = store.async_get(msg["program_id"])
    if original is None:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    copy_data = dict(original)
    copy_data.pop("id", None)
    copy_data["name"] = f"{original.get('name', 'Heating program')} (copy)"
    copy_data["override"] = None
    program = await store.async_create(copy_data)
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"program": program})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/heating_boost",
        vol.Required("program_id"): str,
        vol.Required("temperature"): vol.Coerce(float),
        vol.Required("minutes"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_boost(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    engine = hass.data[DOMAIN]["heating_engine"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    success = await engine.async_boost(msg["program_id"], msg["temperature"], msg["minutes"])
    if not success:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/heating_set_override",
        vol.Required("program_id"): str,
        vol.Required("temperature"): vol.Coerce(float),
        vol.Optional("until"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_set_override(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    engine = hass.data[DOMAIN]["heating_engine"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    success = await engine.async_set_override(msg["program_id"], msg["temperature"], msg.get("until"))
    if not success:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/heating_clear_override", vol.Required("program_id"): str}
)
@websocket_api.async_response
async def ws_clear_override(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    engine = hass.data[DOMAIN]["heating_engine"]
    coordinator = hass.data[DOMAIN]["heating_coordinator"]
    success = await engine.async_clear_override(msg["program_id"])
    if not success:
        connection.send_error(msg["id"], "not_found", "Heating program not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


COMMAND_HANDLERS = (
    ws_list,
    ws_get,
    ws_create,
    ws_update,
    ws_delete,
    ws_set_enabled,
    ws_duplicate,
    ws_boost,
    ws_set_override,
    ws_clear_override,
)


def async_register_heating_websocket_commands(hass: HomeAssistant) -> None:
    for handler in COMMAND_HANDLERS:
        websocket_api.async_register_command(hass, handler)
