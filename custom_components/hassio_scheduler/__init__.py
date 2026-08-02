"""The Scheduler integration.

A fully-featured, UI-driven scheduler for Home Assistant. Schedules are
managed through a dedicated sidebar panel (day/week calendar views) and can
run any Home Assistant action/script sequence at a specific time of day,
relative to sunrise/sunset, on chosen weekdays or on a single date. A
dedicated Heating tab drives `climate` entities from a paintable weekly
temperature grid, with boost/hold overrides.
"""
from __future__ import annotations

import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components.frontend import async_register_built_in_panel, async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
import homeassistant.util.dt as dt_util

from .const import (
    DOMAIN,
    FRONTEND_SCRIPT_URL,
    PANEL_ICON,
    PANEL_NAME,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PLATFORMS,
    SERVICE_DISABLE,
    SERVICE_ENABLE,
    SERVICE_HEATING_BOOST,
    SERVICE_HEATING_CLEAR_OVERRIDE,
    SERVICE_HEATING_SET_OVERRIDE,
    SERVICE_PAUSE,
    SERVICE_REMOVE_SCHEDULE,
    SERVICE_RESUME,
    SERVICE_RUN_NOW,
    VERSION,
)
from .coordinator import SchedulerCoordinator
from .engine import SchedulerEngine
from .global_state import GlobalStateStore
from .global_websocket_api import async_register_global_websocket_commands
from .heating import HeatingEngine
from .heating_coordinator import HeatingCoordinator
from .heating_store import HeatingStore
from .heating_websocket_api import async_register_heating_websocket_commands
from .store import ScheduleStore
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

SERVICE_SCHEDULE_ID_SCHEMA = vol.Schema({vol.Required("schedule_id"): cv.string})
SERVICE_RUN_NOW_SCHEMA = vol.Schema(
    {vol.Required("schedule_id"): cv.string, vol.Optional("timeslot_id"): cv.string}
)
SERVICE_HEATING_BOOST_SCHEMA = vol.Schema(
    {
        vol.Required("program_id"): cv.string,
        vol.Required("temperature"): vol.Coerce(float),
        vol.Optional("minutes", default=60): vol.Coerce(int),
    }
)
SERVICE_HEATING_OVERRIDE_SCHEMA = vol.Schema(
    {
        vol.Required("program_id"): cv.string,
        vol.Required("temperature"): vol.Coerce(float),
        vol.Optional("until"): cv.datetime,
    }
)
SERVICE_HEATING_PROGRAM_ID_SCHEMA = vol.Schema({vol.Required("program_id"): cv.string})

HEATING_SERVICES = (
    SERVICE_HEATING_BOOST,
    SERVICE_HEATING_SET_OVERRIDE,
    SERVICE_HEATING_CLEAR_OVERRIDE,
)
GLOBAL_SERVICES = (SERVICE_PAUSE, SERVICE_RESUME)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Scheduler from a config entry."""
    global_store = GlobalStateStore(hass)
    await global_store.async_load()

    store = ScheduleStore(hass)
    await store.async_load()
    engine = SchedulerEngine(hass, store, global_store)
    coordinator = SchedulerCoordinator(hass, store, engine)

    heating_store = HeatingStore(hass)
    await heating_store.async_load()
    heating_engine = HeatingEngine(hass, heating_store, global_store)
    heating_coordinator = HeatingCoordinator(hass, heating_store, heating_engine)

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN] = {
        "global_store": global_store,
        "store": store,
        "engine": engine,
        "coordinator": coordinator,
        "heating_store": heating_store,
        "heating_engine": heating_engine,
        "heating_coordinator": heating_coordinator,
    }

    await coordinator.async_config_entry_first_refresh()
    await heating_coordinator.async_config_entry_first_refresh()
    engine.async_start()
    heating_engine.async_start()

    async_register_websocket_commands(hass)
    async_register_heating_websocket_commands(hass)
    async_register_global_websocket_commands(hass)
    await _async_register_panel(hass)
    _async_register_services(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        data = hass.data.pop(DOMAIN, {})
        engine: SchedulerEngine | None = data.get("engine")
        coordinator: SchedulerCoordinator | None = data.get("coordinator")
        heating_engine: HeatingEngine | None = data.get("heating_engine")
        heating_coordinator: HeatingCoordinator | None = data.get("heating_coordinator")
        if engine is not None:
            engine.async_stop()
        if coordinator is not None:
            coordinator.async_unload()
        if heating_engine is not None:
            heating_engine.async_stop()
        if heating_coordinator is not None:
            heating_coordinator.async_unload()
        async_remove_panel(hass, PANEL_URL_PATH)
        for service in (SERVICE_RUN_NOW, SERVICE_ENABLE, SERVICE_DISABLE, SERVICE_REMOVE_SCHEDULE):
            hass.services.async_remove(DOMAIN, service)
        for service in HEATING_SERVICES:
            hass.services.async_remove(DOMAIN, service)
        for service in GLOBAL_SERVICES:
            hass.services.async_remove(DOMAIN, service)
    return unload_ok


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Serve the frontend panel bundle and register it in the sidebar."""
    frontend_dir = Path(__file__).parent / "frontend"

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                "/hassio_scheduler_panel",
                str(frontend_dir),
                cache_headers=False,
            )
        ]
    )

    try:
        async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=PANEL_URL_PATH,
            config={
                "_panel_custom": {
                    "name": PANEL_NAME,
                    "embed_iframe": False,
                    "trust_external": False,
                    "module_url": f"{FRONTEND_SCRIPT_URL}?v={VERSION}",
                }
            },
            require_admin=False,
        )
    except ValueError:
        # Panel already registered (e.g. reload of the config entry)
        _LOGGER.debug("Panel %s already registered", PANEL_URL_PATH)


def _async_register_services(hass: HomeAssistant) -> None:
    engine: SchedulerEngine = hass.data[DOMAIN]["engine"]
    store: ScheduleStore = hass.data[DOMAIN]["store"]
    coordinator: SchedulerCoordinator = hass.data[DOMAIN]["coordinator"]
    heating_engine: HeatingEngine = hass.data[DOMAIN]["heating_engine"]
    heating_coordinator: HeatingCoordinator = hass.data[DOMAIN]["heating_coordinator"]
    global_store: GlobalStateStore = hass.data[DOMAIN]["global_store"]

    async def _handle_run_now(call: ServiceCall) -> None:
        await engine.async_run_now(call.data["schedule_id"], call.data.get("timeslot_id"))

    async def _handle_enable(call: ServiceCall) -> None:
        await store.async_set_enabled(call.data["schedule_id"], True)
        await coordinator.async_request_refresh()

    async def _handle_disable(call: ServiceCall) -> None:
        await store.async_set_enabled(call.data["schedule_id"], False)
        await coordinator.async_request_refresh()

    async def _handle_remove(call: ServiceCall) -> None:
        await store.async_delete(call.data["schedule_id"])
        await coordinator.async_request_refresh()

    async def _handle_heating_boost(call: ServiceCall) -> None:
        await heating_engine.async_boost(call.data["program_id"], call.data["temperature"], call.data["minutes"])
        await heating_coordinator.async_request_refresh()

    async def _handle_heating_set_override(call: ServiceCall) -> None:
        until = call.data.get("until")
        until_iso = dt_util.as_local(until).isoformat() if until else None
        await heating_engine.async_set_override(call.data["program_id"], call.data["temperature"], until_iso)
        await heating_coordinator.async_request_refresh()

    async def _handle_heating_clear_override(call: ServiceCall) -> None:
        await heating_engine.async_clear_override(call.data["program_id"])
        await heating_coordinator.async_request_refresh()

    async def _handle_pause(call: ServiceCall) -> None:
        await global_store.async_set_paused(True)

    async def _handle_resume(call: ServiceCall) -> None:
        await global_store.async_set_paused(False)

    if not hass.services.has_service(DOMAIN, SERVICE_RUN_NOW):
        hass.services.async_register(
            DOMAIN, SERVICE_RUN_NOW, _handle_run_now, schema=SERVICE_RUN_NOW_SCHEMA
        )
        hass.services.async_register(
            DOMAIN, SERVICE_ENABLE, _handle_enable, schema=SERVICE_SCHEDULE_ID_SCHEMA
        )
        hass.services.async_register(
            DOMAIN, SERVICE_DISABLE, _handle_disable, schema=SERVICE_SCHEDULE_ID_SCHEMA
        )
        hass.services.async_register(
            DOMAIN, SERVICE_REMOVE_SCHEDULE, _handle_remove, schema=SERVICE_SCHEDULE_ID_SCHEMA
        )

    if not hass.services.has_service(DOMAIN, SERVICE_HEATING_BOOST):
        hass.services.async_register(
            DOMAIN, SERVICE_HEATING_BOOST, _handle_heating_boost, schema=SERVICE_HEATING_BOOST_SCHEMA
        )
        hass.services.async_register(
            DOMAIN,
            SERVICE_HEATING_SET_OVERRIDE,
            _handle_heating_set_override,
            schema=SERVICE_HEATING_OVERRIDE_SCHEMA,
        )
        hass.services.async_register(
            DOMAIN,
            SERVICE_HEATING_CLEAR_OVERRIDE,
            _handle_heating_clear_override,
            schema=SERVICE_HEATING_PROGRAM_ID_SCHEMA,
        )

    if not hass.services.has_service(DOMAIN, SERVICE_PAUSE):
        hass.services.async_register(DOMAIN, SERVICE_PAUSE, _handle_pause, schema=vol.Schema({}))
        hass.services.async_register(DOMAIN, SERVICE_RESUME, _handle_resume, schema=vol.Schema({}))
