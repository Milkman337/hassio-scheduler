"""A tiny persisted flag that pauses every schedule and heating program at once.

This is the "master switch" - e.g. for a holiday where nothing should run
without having to remember (and later restore) each item's individual
enabled state. Both engines check `paused` on every tick and simply skip
all evaluation while it is set.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import SIGNAL_GLOBAL_UPDATED, STORAGE_KEY_GLOBAL, STORAGE_VERSION


class GlobalStateStore:
    """Wrapper around the HA Store helper that keeps the global pause flag."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_GLOBAL)
        self.paused = False

    async def async_load(self) -> None:
        data = await self._store.async_load()
        self.paused = bool((data or {}).get("paused", False))

    async def async_set_paused(self, paused: bool) -> None:
        if self.paused == paused:
            return
        self.paused = paused
        await self._store.async_save({"paused": self.paused})
        async_dispatcher_send(self._hass, SIGNAL_GLOBAL_UPDATED)
