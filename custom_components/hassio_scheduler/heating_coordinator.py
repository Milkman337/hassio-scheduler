"""Coordinator that keeps heating entity state / websocket data fresh."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
import homeassistant.util.dt as dt_util

from .const import DOMAIN, SIGNAL_HEATING_UPDATED
from .heating import HeatingEngine, resolve_target_temperature
from .heating_store import HeatingStore

_LOGGER = logging.getLogger(__name__)
UPDATE_INTERVAL = timedelta(seconds=30)


class HeatingCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Recomputes per-program display data (current target temperature, etc.)."""

    def __init__(self, hass: HomeAssistant, store: HeatingStore, engine: HeatingEngine) -> None:
        super().__init__(hass, _LOGGER, name=f"{DOMAIN}_heating", update_interval=UPDATE_INTERVAL)
        self.store = store
        self.engine = engine
        self._unsub_signal = async_dispatcher_connect(hass, SIGNAL_HEATING_UPDATED, self._handle_signal)

    def _handle_signal(self) -> None:
        self.hass.async_create_task(self.async_refresh())

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        now_local = dt_util.now()
        result: dict[str, dict[str, Any]] = {}
        for program_id, program in self.store.programs.items():
            temperature, source = resolve_target_temperature(program, now_local)
            result[program_id] = {
                "program": program,
                "target_temperature": temperature,
                "source": source,
            }
        return result

    def async_unload(self) -> None:
        self._unsub_signal()
