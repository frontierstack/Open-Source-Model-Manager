#!/usr/bin/env python3
"""
Scrapling web fetcher service - provides captcha-evading web scraping
Called from Node.js via subprocess for web fetching operations

Supports SSL inspection bypass for corporate proxy environments.
Auto-configured by build.sh when corporate proxy is detected.
"""

# ============================================================================
# SSL INSPECTION BYPASS - MUST BE BEFORE ALL IMPORTS
# ============================================================================
# curl_cffi (used by Scrapling) reads env vars at import time, so we must
# set these BEFORE importing anything that might trigger curl_cffi import
import os

SSL_BYPASS_ENABLED = os.environ.get('NODE_TLS_REJECT_UNAUTHORIZED') == '0'

if SSL_BYPASS_ENABLED:
    # Set environment variables BEFORE any other imports
    # curl_cffi uses these to configure SSL verification
    os.environ['PYTHONHTTPSVERIFY'] = '0'
    os.environ['CURL_CA_BUNDLE'] = ''
    os.environ['REQUESTS_CA_BUNDLE'] = ''
    os.environ['SSL_CERT_FILE'] = ''
    # For curl_cffi specifically
    os.environ['CURL_SSL_NO_REVOKE'] = '1'

import sys
import json
import argparse
import ssl
import warnings
from typing import Optional

# Apply additional SSL bypass after imports
if SSL_BYPASS_ENABLED:
    # Disable SSL verification warnings
    warnings.filterwarnings('ignore', message='Unverified HTTPS request')
    warnings.filterwarnings('ignore', category=DeprecationWarning)

    # Disable SSL verification globally for urllib3/requests (if available)
    try:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except ImportError:
        pass

    # Create unverified SSL context as default
    try:
        ssl._create_default_https_context = ssl._create_unverified_context
    except AttributeError:
        pass

    print('[Scrapling] SSL bypass enabled for corporate proxy environment', file=sys.stderr)

    # Monkey-patch curl_cffi to disable SSL verification by default
    try:
        import curl_cffi.requests
        _original_request = curl_cffi.requests.Session.request

        def _patched_request(self, method, url, **kwargs):
            kwargs.setdefault('verify', False)
            return _original_request(self, method, url, **kwargs)

        curl_cffi.requests.Session.request = _patched_request
        print('[Scrapling] curl_cffi SSL verification disabled', file=sys.stderr)
    except Exception as e:
        print(f'[Scrapling] Warning: Could not patch curl_cffi: {e}', file=sys.stderr)

def fetch_url(url: str, headless: bool = True, solve_cloudflare: bool = True,
              timeout: int = 30000, extract_links: bool = False) -> dict:
    """
    Fetch a URL using Scrapling's StealthyFetcher for anti-bot evasion

    Args:
        url: The URL to fetch
        headless: Run browser in headless mode
        solve_cloudflare: Attempt to bypass Cloudflare protection
        timeout: Request timeout in milliseconds
        extract_links: Whether to extract all links from the page

    Returns:
        dict with content, title, links, and metadata
    """
    try:
        from scrapling.fetchers import StealthyFetcher, Fetcher

        result = {
            'success': True,
            'url': url,
            'content': '',
            'title': '',
            'links': [],
            'error': None
        }

        try:
            # Build fetcher options
            fetcher_opts = {
                'headless': headless,
                'timeout': timeout // 1000,  # Convert to seconds
                'block_images': True,  # Speed up loading
            }

            # Add SSL bypass if enabled (ignore certificate errors)
            if SSL_BYPASS_ENABLED:
                fetcher_opts['ignore_https_errors'] = True

            # Try StealthyFetcher first for captcha evasion
            page = StealthyFetcher.fetch(url, **fetcher_opts)

            # Extract text content
            # Get the main text content, removing scripts and styles
            text_content = page.get_all_text(separator='\n', strip=True)

            # If content is too thin, try waiting longer and re-fetching
            # (some sites need extra time for JS to render after CAPTCHA bypass)
            if not text_content or len(text_content.strip()) < 200:
                import time
                time.sleep(2)
                # Try to get text again from a fresh fetch with longer timeout
                try:
                    page2 = StealthyFetcher.fetch(url, **{**fetcher_opts, 'timeout': max(fetcher_opts.get('timeout', 30), 45)})
                    text_content2 = page2.get_all_text(separator='\n', strip=True)
                    if text_content2 and len(text_content2) > len(text_content or ''):
                        text_content = text_content2
                        page = page2
                except Exception:
                    pass  # Keep original thin content

            result['content'] = text_content[:50000] if text_content else ''  # Limit content size

            # Get title
            title_elems = page.css('title')
            if title_elems and len(title_elems) > 0:
                result['title'] = title_elems[0].text or ''

            # Extract links if requested
            if extract_links:
                links = []
                for link in page.css('a[href]'):
                    href = link.attrib.get('href', '')
                    text = link.text or href
                    if href and href.startswith(('http://', 'https://')):
                        links.append({'url': href, 'text': text[:100]})
                result['links'] = links[:100]  # Limit to 100 links

        except Exception as stealth_err:
            # Fall back to basic Fetcher if StealthyFetcher fails
            try:
                # Build fetcher options for fallback
                fallback_opts = {'timeout': timeout // 1000}
                if SSL_BYPASS_ENABLED:
                    fallback_opts['verify'] = False

                fetcher = Fetcher()
                page = fetcher.get(url, **fallback_opts)
                text_content = page.get_all_text(separator='\n', strip=True)
                result['content'] = text_content[:50000] if text_content else ''

                title_elems = page.css('title')
                if title_elems and len(title_elems) > 0:
                    result['title'] = title_elems[0].text or ''

            except Exception as fetch_err:
                result['success'] = False
                result['error'] = f'Both StealthyFetcher and Fetcher failed: {str(stealth_err)} | {str(fetch_err)}'

        return result

    except ImportError as ie:
        return {
            'success': False,
            'url': url,
            'content': '',
            'title': '',
            'links': [],
            'error': f'Scrapling not installed: {str(ie)}'
        }
    except Exception as e:
        return {
            'success': False,
            'url': url,
            'content': '',
            'title': '',
            'links': [],
            'error': str(e)
        }


def search_and_fetch(query: str, max_results: int = 5) -> dict:
    """
    Perform a web search and fetch results using Scrapling

    Args:
        query: Search query
        max_results: Maximum number of results to return

    Returns:
        dict with search results
    """
    try:
        from scrapling.fetchers import Fetcher
        import urllib.parse

        # Use DuckDuckGo HTML search
        encoded_query = urllib.parse.quote_plus(query)
        search_url = f'https://html.duckduckgo.com/html/?q={encoded_query}'

        # Build fetcher options
        fetcher_opts = {'timeout': 15}
        if SSL_BYPASS_ENABLED:
            fetcher_opts['verify'] = False

        fetcher = Fetcher()
        page = fetcher.get(search_url, **fetcher_opts)

        results = []
        for result in page.css('.result'):
            title_elems = result.css('.result__title a')
            snippet_elems = result.css('.result__snippet')

            if title_elems and len(title_elems) > 0:
                title_elem = title_elems[0]
                title = title_elem.text or ''
                raw_url = title_elem.attrib.get('href', '')
                snippet = snippet_elems[0].text if snippet_elems and len(snippet_elems) > 0 else ''

                # Decode DDG redirect URL
                url = raw_url
                if '//duckduckgo.com/l/' in raw_url and 'uddg=' in raw_url:
                    try:
                        uddg_start = raw_url.index('uddg=') + 5
                        uddg_end = raw_url.index('&', uddg_start) if '&' in raw_url[uddg_start:] else len(raw_url)
                        url = urllib.parse.unquote(raw_url[uddg_start:uddg_end])
                    except:
                        pass

                if url and title and url.startswith('http'):
                    results.append({
                        'title': title[:200],
                        'url': url,
                        'snippet': (snippet[:300] if snippet else '')
                    })

                    if len(results) >= max_results:
                        break

        return {
            'success': True,
            'query': query,
            'results': results,
            'error': None
        }

    except Exception as e:
        return {
            'success': False,
            'query': query,
            'results': [],
            'error': str(e)
        }


def main():
    parser = argparse.ArgumentParser(description='Scrapling web fetcher')
    parser.add_argument('--action', choices=['fetch', 'search'], required=True,
                       help='Action to perform')
    parser.add_argument('--url', type=str, help='URL to fetch')
    parser.add_argument('--query', type=str, help='Search query')
    parser.add_argument('--headless', type=bool, default=True,
                       help='Run browser in headless mode')
    parser.add_argument('--timeout', type=int, default=30000,
                       help='Timeout in milliseconds')
    parser.add_argument('--extract-links', action='store_true',
                       help='Extract links from page')
    parser.add_argument('--max-results', type=int, default=5,
                       help='Maximum search results')

    args = parser.parse_args()

    if args.action == 'fetch':
        if not args.url:
            print(json.dumps({'success': False, 'error': 'URL required for fetch'}))
            sys.exit(1)
        result = fetch_url(
            args.url,
            headless=args.headless,
            timeout=args.timeout,
            extract_links=args.extract_links
        )
    elif args.action == 'search':
        if not args.query:
            print(json.dumps({'success': False, 'error': 'Query required for search'}))
            sys.exit(1)
        result = search_and_fetch(args.query, args.max_results)

    print(json.dumps(result))


if __name__ == '__main__':
    main()
