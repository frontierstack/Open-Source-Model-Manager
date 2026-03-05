"""
title: Web Search
author: ModelServer
author_url: https://github.com/frontierstack/Open-Source-Model-Manager
version: 1.0.0
license: MIT
description: Search the web using DuckDuckGo with Playwright content fetching via ModelServer API
required_open_webui_version: 0.4.0
"""

import json
import urllib.request
import urllib.parse
import ssl
from pydantic import BaseModel, Field
from typing import Optional


class Tools:
    class Valves(BaseModel):
        API_BASE_URL: str = Field(
            default="http://host.docker.internal:3080",
            description="ModelServer API URL (internal Docker URL)"
        )
        API_KEY: str = Field(
            default="",
            description="API Key from ModelServer API Keys tab"
        )
        API_SECRET: str = Field(
            default="",
            description="API Secret from ModelServer API Keys tab"
        )
        RESULT_COUNT: int = Field(
            default=5,
            description="Number of search results to return (1-10)"
        )
        FETCH_PAGE_CONTENT: bool = Field(
            default=True,
            description="Fetch actual page content from top results"
        )

    def __init__(self):
        self.valves = self.Valves()

    async def web_search(
        self,
        query: str,
        __event_emitter__=None
    ) -> str:
        """
        Search the web for current information, news, or documentation.
        :param query: The search query
        :return: Search results with titles, URLs, and content
        """

        if __event_emitter__:
            await __event_emitter__({"type": "status", "data": {"description": f"Searching: {query}", "done": False}})

        try:
            params = {
                "q": query,
                "limit": min(self.valves.RESULT_COUNT, 10),
                "fetchContent": "true" if self.valves.FETCH_PAGE_CONTENT else "false",
                "contentLimit": 3
            }

            url = f"{self.valves.API_BASE_URL}/api/search?{urllib.parse.urlencode(params)}"

            req = urllib.request.Request(url)
            req.add_header("Content-Type", "application/json")

            if self.valves.API_KEY and self.valves.API_SECRET:
                req.add_header("X-API-Key", self.valves.API_KEY)
                req.add_header("X-API-Secret", self.valves.API_SECRET)

            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            with urllib.request.urlopen(req, timeout=30, context=ctx) as response:
                data = json.loads(response.read().decode("utf-8"))

            results = data.get("results", [])

            if not results:
                if __event_emitter__:
                    await __event_emitter__({"type": "status", "data": {"description": "No results found", "done": True}})
                return f"No results found for: {query}"

            output = [f"## Search Results for: {query}\n"]

            for i, r in enumerate(results, 1):
                output.append(f"### {i}. {r.get('title', 'Untitled')}")
                output.append(f"URL: {r.get('url', '')}")
                if r.get('snippet'):
                    output.append(f"Summary: {r['snippet']}")
                if r.get('content') and r.get('contentFetched'):
                    content = r['content'][:1500] + "..." if len(r.get('content', '')) > 1500 else r.get('content', '')
                    output.append(f"\nContent:\n{content}")
                output.append("")

            if __event_emitter__:
                await __event_emitter__({"type": "status", "data": {"description": f"Found {len(results)} results", "done": True}})

            return "\n".join(output)

        except Exception as e:
            error_msg = str(e)
            if __event_emitter__:
                await __event_emitter__({"type": "status", "data": {"description": f"Error: {error_msg}", "done": True}})
            return f"Search error: {error_msg}. Check API credentials in function settings."
