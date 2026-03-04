"""
Patched OutlookMessageLoader that handles emails with no plain text body.
This fixes the "page_content Input should be a valid string" error.
"""
import os
from pathlib import Path
from typing import Iterator, Union
from langchain_core.documents import Document
from langchain_community.document_loaders.base import BaseLoader


class PatchedOutlookMessageLoader(BaseLoader):
    """
    Patched Outlook Message loader that handles emails with no plain text body.
    Falls back to HTML body or empty string to prevent None values.
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
        import re

        msg = extract_msg.Message(self.file_path)

        # Try to get content in order of preference
        content = None

        # First try plain text body
        if msg.body:
            content = msg.body
        # Fall back to HTML body, strip HTML tags for plain text
        elif msg.htmlBody:
            # Simple HTML tag removal
            html_content = msg.htmlBody
            if isinstance(html_content, bytes):
                html_content = html_content.decode('utf-8', errors='replace')
            # Remove HTML tags
            content = re.sub(r'<[^>]+>', '', html_content)
            # Clean up whitespace
            content = re.sub(r'\s+', ' ', content).strip()
        # Last resort: empty string
        else:
            content = ""

        # Build metadata
        metadata = {
            "source": self.file_path,
            "subject": msg.subject or "",
            "sender": msg.sender or "",
            "date": str(msg.date) if msg.date else "",
        }

        # Add recipients if available
        if msg.to:
            metadata["to"] = msg.to
        if msg.cc:
            metadata["cc"] = msg.cc

        msg.close()

        yield Document(
            page_content=content,
            metadata=metadata,
        )
