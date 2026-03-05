"""
title: Web Search
author: ModelServer
version: 1.0.0
description: Search the web using the ModelServer search API with DuckDuckGo and Playwright content fetching
required_open_webui_version: 0.4.0
"""

import os
import json
import urllib.request
import urllib.parse
import ssl
from typing import Callable, Any
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        """Configuration options for the web search tool"""
        API_BASE_URL: str = Field(
            default="http://host.docker.internal:3080",
            description="Base URL of the ModelServer API (use internal Docker URL)"
        )
        API_KEY: str = Field(
            default="",
            description="API Key for authentication"
        )
        API_SECRET: str = Field(
            default="",
            description="API Secret for authentication"
        )
        DEFAULT_LIMIT: int = Field(
            default=5,
            description="Default number of search results to return"
        )
        FETCH_CONTENT: bool = Field(
            default=True,
            description="Fetch actual page content from search results"
        )
        CONTENT_LIMIT: int = Field(
            default=3,
            description="Number of URLs to fetch full content from"
        )

    def __init__(self):
        self.valves = self.Valves()

    def search_web(
        self,
        query: str,
        __event_emitter__: Callable[[dict], Any] = None,
    ) -> str:
        """
        Search the web for information on a given topic.
        Use this tool when you need to find current information, news, documentation, or answers that may not be in your training data.

        :param query: The search query to look up on the web
        :return: Search results with titles, URLs, snippets, and optionally full page content
        """

        if __event_emitter__:
            __event_emitter__({"type": "status", "data": {"description": f"Searching: {query}", "done": False}})

        try:
            # Build the search URL
            params = {
                "q": query,
                "limit": self.valves.DEFAULT_LIMIT,
                "fetchContent": str(self.valves.FETCH_CONTENT).lower(),
                "contentLimit": self.valves.CONTENT_LIMIT
            }

            url = f"{self.valves.API_BASE_URL}/api/search?{urllib.parse.urlencode(params)}"

            # Create request with authentication headers
            req = urllib.request.Request(url)
            req.add_header("Content-Type", "application/json")

            if self.valves.API_KEY and self.valves.API_SECRET:
                req.add_header("X-API-Key", self.valves.API_KEY)
                req.add_header("X-API-Secret", self.valves.API_SECRET)

            # Create SSL context that allows self-signed certificates
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            # Make the request
            with urllib.request.urlopen(req, timeout=30, context=ctx) as response:
                data = json.loads(response.read().decode("utf-8"))

            # Format results for the LLM
            results = data.get("results", [])

            if not results:
                if __event_emitter__:
                    __event_emitter__({"type": "status", "data": {"description": "No results found", "done": True}})
                return f"No search results found for: {query}"

            # Build formatted output
            output_parts = [f"## Web Search Results for: {query}\n"]

            if data.get("enhancedQuery") and data["enhancedQuery"] != query:
                output_parts.append(f"*Enhanced query: {data['enhancedQuery']}*\n")

            output_parts.append(f"Found {len(results)} results:\n")

            for i, result in enumerate(results, 1):
                title = result.get("title", "No title")
                url = result.get("url", "")
                snippet = result.get("snippet", "")
                content = result.get("content", "")

                output_parts.append(f"\n### {i}. {title}")
                output_parts.append(f"**URL:** {url}")

                if snippet:
                    output_parts.append(f"**Snippet:** {snippet}")

                if content and result.get("contentFetched"):
                    # Truncate content if too long
                    max_content_len = 2000
                    if len(content) > max_content_len:
                        content = content[:max_content_len] + "..."
                    output_parts.append(f"\n**Page Content:**\n{content}")

                output_parts.append("")  # Empty line between results

            if __event_emitter__:
                __event_emitter__({"type": "status", "data": {"description": f"Found {len(results)} results", "done": True}})

            return "\n".join(output_parts)

        except urllib.error.HTTPError as e:
            error_msg = f"Search API error: {e.code} - {e.reason}"
            if __event_emitter__:
                __event_emitter__({"type": "status", "data": {"description": error_msg, "done": True}})
            return f"Error searching the web: {error_msg}. Please check API credentials in Valves settings."

        except urllib.error.URLError as e:
            error_msg = f"Connection error: {str(e.reason)}"
            if __event_emitter__:
                __event_emitter__({"type": "status", "data": {"description": error_msg, "done": True}})
            return f"Error connecting to search API: {error_msg}. Please check the API_BASE_URL in Valves settings."

        except Exception as e:
            error_msg = str(e)
            if __event_emitter__:
                __event_emitter__({"type": "status", "data": {"description": f"Error: {error_msg}", "done": True}})
            return f"Error performing web search: {error_msg}"
