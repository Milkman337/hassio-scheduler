"""WebSocket API used by the frontend panel."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@websocket_api.async_response
async def ws_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]
    coordinator = data["coordinator"]
    store = data["store"]
    result = []
    for schedule_id, schedule in store.schedules.items():
        extra = coordinator.data.get(schedule_id, {}) if coordinator.data else {}
        result.append(
            {
                **schedule,
                "next_run": extra.get("next_run"),
                "last_triggered": extra.get("last_triggered"),
            }
        )
    connection.send_result(msg["id"], {"schedules": result})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get", vol.Required("schedule_id"): str}
)
@websocket_api.async_response
async def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["store"]
    schedule = store.async_get(msg["schedule_id"])
    if schedule is None:
        connection.send_error(msg["id"], "not_found", "Schedule not found")
        return
    connection.send_result(msg["id"], {"schedule": schedule})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/create", vol.Required("schedule"): dict}
)
@websocket_api.async_response
async def ws_create(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["store"]
    coordinator = hass.data[DOMAIN]["coordinator"]
    schedule = await store.async_create(msg["schedule"])
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"schedule": schedule})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/update",
        vol.Required("schedule_id"): str,
        vol.Required("schedule"): dict,
    }
)
@websocket_api.async_response
async def ws_update(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["store"]
    coordinator = hass.data[DOMAIN]["coordinator"]
    try:
        schedule = await store.async_update(msg["schedule_id"], msg["schedule"])
    except KeyError:
        connection.send_error(msg["id"], "not_found", "Schedule not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"schedule": schedule})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/delete", vol.Required("schedule_id"): str}
)
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    store = hass.data[DOMAIN]["store"]
    coordinator = hass.data[DOMAIN]["coordinator"]
    await store.async_delete(msg["schedule_id"])
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_enabled",
        vol.Required("schedule_id"): str,
        vol.Required("enabled"): bool,
    }
)
@websocket_api.async_response
async def ws_set_enabled(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    store = hass.data[DOMAIN]["store"]
    coordinator = hass.data[DOMAIN]["coordinator"]
    schedule = await store.async_set_enabled(msg["schedule_id"], msg["enabled"])
    if schedule is None:
        connection.send_error(msg["id"], "not_found", "Schedule not found")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"schedule": schedule})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/duplicate",
        vol.Required("schedule_id"): str,
    }
)
@websocket_api.async_response
async def ws_duplicate(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    store = hass.data[DOMAIN]["store"]
    coordinator = hass.data[DOMAIN]["coordinator"]
    original = store.async_get(msg["schedule_id"])
    if original is None:
        connection.send_error(msg["id"], "not_found", "Schedule not found")
        return
    copy_data = dict(original)
    copy_data.pop("id", None)
    copy_data["name"] = f"{original.get('name', 'Schedule')} (copy)"
    for slot in copy_data.get("timeslots", []):
        slot.pop("id", None)
    schedule = await store.async_create(copy_data)
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"schedule": schedule})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/run_now",
        vol.Required("schedule_id"): str,
        vol.Optional("timeslot_id"): str,
    }
)
@websocket_api.async_response
async def ws_run_now(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    engine = hass.data[DOMAIN]["engine"]
    success = await engine.async_run_now(msg["schedule_id"], msg.get("timeslot_id"))
    if not success:
        connection.send_error(msg["id"], "not_found", "Schedule or timeslot not found")
        return
    connection.send_result(msg["id"], {"success": True})


COMMAND_HANDLERS = (
    ws_list,
    ws_get,
    ws_create,
    ws_update,
    ws_delete,
    ws_set_enabled,
    ws_duplicate,
    ws_run_now,
)


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all websocket commands for this integration."""
    for handler in COMMAND_HANDLERS:
        websocket_api.async_register_command(hass, handler)
