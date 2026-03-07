"""
Patched OutlookMessageLoader that handles emails with no plain text body.
This fixes the "page_content Input should be a valid string" error.
Enhanced to properly extract links, attachments, and structured content.
"""
import os
import re
from pathlib import Path
from typing import Iterator, Union, List, Tuple
from langchain_core.documents import Document
from langchain_community.document_loaders.base import BaseLoader


def extract_links_from_html(html_content: str) -> List[Tuple[str, str]]:
    """Extract links from HTML content as (text, url) tuples."""
    links = []
    # Match <a> tags with href
    pattern = r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>'
    for match in re.finditer(pattern, html_content, re.IGNORECASE | re.DOTALL):
        url = match.group(1)
        text = re.sub(r'<[^>]+>', '', match.group(2)).strip()  # Remove nested tags
        if url and not url.startswith('#') and not url.startswith('mailto:'):
            links.append((text or url, url))
        elif url and url.startswith('mailto:'):
            # Extract email from mailto links
            email = url.replace('mailto:', '').split('?')[0]
            links.append((text or email, email))
    return links


def html_to_text(html_content: str) -> str:
    """Convert HTML to readable text, preserving structure and links."""
    if not html_content:
        return ""

    text = html_content

    # Decode if bytes
    if isinstance(text, bytes):
        text = text.decode('utf-8', errors='replace')

    # Remove style and script blocks entirely
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.IGNORECASE | re.DOTALL)

    # Convert links to readable format: "text (url)" or just "url"
    def replace_link(match):
        url = match.group(1)
        link_text = re.sub(r'<[^>]+>', '', match.group(2)).strip()
        if url.startswith('mailto:'):
            email = url.replace('mailto:', '').split('?')[0]
            return f"{link_text} <{email}>" if link_text and link_text != email else f"<{email}>"
        if link_text and link_text != url and not link_text.startswith('http'):
            return f"{link_text} ({url})"
        return url

    text = re.sub(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                  replace_link, text, flags=re.IGNORECASE | re.DOTALL)

    # Convert block elements to newlines
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</p>', '\n\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</div>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</tr>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</td>', '\t', text, flags=re.IGNORECASE)
    text = re.sub(r'</li>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<h[1-6][^>]*>', '\n\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</h[1-6]>', '\n', text, flags=re.IGNORECASE)

    # Convert list markers
    text = re.sub(r'<li[^>]*>', '\n• ', text, flags=re.IGNORECASE)

    # Remove remaining HTML tags
    text = re.sub(r'<[^>]+>', '', text)

    # Decode HTML entities
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'&#39;', "'", text)
    text = re.sub(r'&rsquo;', "'", text)
    text = re.sub(r'&lsquo;', "'", text)
    text = re.sub(r'&rdquo;', '"', text)
    text = re.sub(r'&ldquo;', '"', text)
    text = re.sub(r'&ndash;', '-', text)
    text = re.sub(r'&mdash;', '—', text)
    text = re.sub(r'&bull;', '•', text)
    text = re.sub(r'&#\d+;', '', text)  # Remove remaining numeric entities

    # Clean up whitespace
    text = re.sub(r'[ \t]+', ' ', text)  # Collapse horizontal whitespace
    text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)  # Max 2 consecutive newlines
    text = '\n'.join(line.strip() for line in text.split('\n'))  # Strip each line
    text = text.strip()

    return text


class PatchedOutlookMessageLoader(BaseLoader):
    """
    Patched Outlook Message loader that handles emails with no plain text body.
    Falls back to HTML body with proper link extraction.
    Includes attachments and structured metadata.
    """

    def __init__(self, file_path: Union[str, Path]):
        """Initialize with a file path.

        Args:
            file_path: The path to the Outlook Message file.
        """
        self.file_path = str(file_path)

        if not os.path.isfile(self.file_path):
            raise ValueError(f"File path {self.file_path} is not a valid file")

        try:
            import extract_msg  # noqa:F401
        except ImportError:
            raise ImportError(
                "extract_msg is not installed. Please install it with "
                "`pip install extract_msg`"
            )

    def lazy_load(self) -> Iterator[Document]:
        import extract_msg

        msg = extract_msg.Message(self.file_path)

        # Build content sections
        content_parts = []

        # Email header info
        header_parts = []
        if msg.subject:
            header_parts.append(f"Subject: {msg.subject}")
        if msg.sender:
            header_parts.append(f"From: {msg.sender}")
        if msg.to:
            header_parts.append(f"To: {msg.to}")
        if msg.cc:
            header_parts.append(f"CC: {msg.cc}")
        if msg.date:
            header_parts.append(f"Date: {msg.date}")

        if header_parts:
            content_parts.append("=== EMAIL HEADER ===")
            content_parts.extend(header_parts)
            content_parts.append("")

        # Email body
        body_content = None
        links_extracted = []

        # First try plain text body
        if msg.body and msg.body.strip():
            body_content = msg.body.strip()
            # Try to extract URLs from plain text too
            url_pattern = r'https?://[^\s<>"\')\]]+|www\.[^\s<>"\')\]]+'
            found_urls = re.findall(url_pattern, body_content)
            links_extracted = [(url, url) for url in found_urls]

        # Fall back to HTML body with proper parsing
        elif msg.htmlBody:
            html_content = msg.htmlBody
            if isinstance(html_content, bytes):
                html_content = html_content.decode('utf-8', errors='replace')

            # Extract links before converting to text
            links_extracted = extract_links_from_html(html_content)

            # Convert HTML to readable text
            body_content = html_to_text(html_content)

        if body_content:
            content_parts.append("=== EMAIL BODY ===")
            content_parts.append(body_content)
            content_parts.append("")

        # Extract and list links
        if links_extracted:
            content_parts.append("=== LINKS FOUND ===")
            seen_urls = set()
            for text, url in links_extracted:
                if url not in seen_urls:
                    seen_urls.add(url)
                    if text and text != url:
                        content_parts.append(f"• {text}: {url}")
                    else:
                        content_parts.append(f"• {url}")
            content_parts.append("")

        # List attachments
        attachments_info = []
        try:
            if hasattr(msg, 'attachments') and msg.attachments:
                for att in msg.attachments:
                    att_name = getattr(att, 'longFilename', None) or getattr(att, 'shortFilename', None) or 'unnamed'
                    att_size = getattr(att, 'size', None)
                    if att_size:
                        # Format size nicely
                        if att_size > 1024 * 1024:
                            size_str = f"{att_size / (1024*1024):.1f} MB"
                        elif att_size > 1024:
                            size_str = f"{att_size / 1024:.1f} KB"
                        else:
                            size_str = f"{att_size} bytes"
                        attachments_info.append(f"• {att_name} ({size_str})")
                    else:
                        attachments_info.append(f"• {att_name}")
        except Exception:
            pass  # Ignore attachment extraction errors

        if attachments_info:
            content_parts.append("=== ATTACHMENTS ===")
            content_parts.extend(attachments_info)
            content_parts.append("")

        # Combine all content
        full_content = '\n'.join(content_parts).strip()

        # Ensure we have some content
        if not full_content:
            full_content = "(Empty email - no readable content found)"

        # Build metadata
        metadata = {
            "source": self.file_path,
            "subject": msg.subject or "",
            "sender": msg.sender or "",
            "date": str(msg.date) if msg.date else "",
            "type": "email",
            "format": "msg",
        }

        # Add recipients if available
        if msg.to:
            metadata["to"] = msg.to
        if msg.cc:
            metadata["cc"] = msg.cc

        # Add links to metadata for easy access
        if links_extracted:
            metadata["links"] = [url for _, url in links_extracted]
            metadata["link_count"] = len(links_extracted)

        # Add attachment info to metadata
        if attachments_info:
            metadata["attachments"] = [a.lstrip('• ') for a in attachments_info]
            metadata["attachment_count"] = len(attachments_info)

        msg.close()

        yield Document(
            page_content=full_content,
            metadata=metadata,
        )
