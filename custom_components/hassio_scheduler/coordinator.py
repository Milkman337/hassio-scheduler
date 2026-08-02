"""Coordinator that keeps entity state in sync with the schedule store."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN, SIGNAL_SCHEDULES_UPDATED
from .engine import SchedulerEngine
from .store import ScheduleStore

_LOGGER = logging.getLogger(__name__)
UPDATE_INTERVAL = timedelta(seconds=30)


class SchedulerCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Recomputes per-schedule display data (next run, etc.)."""

    def __init__(self, hass: HomeAssistant, store: ScheduleStore, engine: SchedulerEngine) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=UPDATE_INTERVAL)
        self.store = store
        self.engine = engine
        self._unsub_signal = async_dispatcher_connect(
            hass, SIGNAL_SCHEDULES_UPDATED, self._handle_signal
        )

    def _handle_signal(self) -> None:
        self.hass.async_create_task(self.async_refresh())

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for schedule_id, schedule in self.store.schedules.items():
            result[schedule_id] = {
                "schedule": schedule,
                "next_run": self.engine.compute_next_run(schedule),
                "last_triggered": self.engine.last_triggered.get(schedule_id),
            }
        return result

    def async_unload(self) -> None:
        self._unsub_signal()
