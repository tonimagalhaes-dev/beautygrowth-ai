"""MinIO/S3-compatible storage client for the Designer Agent workflow.

Implements the StorageClient protocol defined in designer_agent.py,
providing async upload and presigned URL generation using the minio SDK.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from datetime import timedelta

from minio import Minio

logger = logging.getLogger(__name__)


class MinioStorageClient:
    """Async-compatible MinIO storage client implementing StorageClient protocol.

    Uses the minio Python SDK (synchronous) wrapped with asyncio.to_thread
    for non-blocking I/O in the async workflow.

    Environment variables:
        MINIO_ENDPOINT: MinIO server endpoint (default: localhost:9000)
        MINIO_ACCESS_KEY: Access key (default: beautygrowth)
        MINIO_SECRET_KEY: Secret key (default: beautygrowth_dev)
        MINIO_BUCKET: Bucket name (default: beauty-growth-ai)
        MINIO_SECURE: Use HTTPS (default: false)
    """

    def __init__(
        self,
        endpoint: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        bucket: str | None = None,
        secure: bool | None = None,
    ) -> None:
        self._endpoint = endpoint or os.environ.get("MINIO_ENDPOINT", "localhost:9000")
        self._access_key = access_key or os.environ.get("MINIO_ACCESS_KEY", "beautygrowth")
        self._secret_key = secret_key or os.environ.get("MINIO_SECRET_KEY", "beautygrowth_dev")
        self._bucket = bucket or os.environ.get("MINIO_BUCKET", "beauty-growth-ai")

        if secure is not None:
            self._secure = secure
        else:
            self._secure = os.environ.get("MINIO_SECURE", "false").lower() == "true"

        self._client = Minio(
            self._endpoint,
            access_key=self._access_key,
            secret_key=self._secret_key,
            secure=self._secure,
        )

        logger.info(
            "MinioStorageClient initialized: endpoint=%s, bucket=%s, secure=%s",
            self._endpoint,
            self._bucket,
            self._secure,
        )

    def _ensure_bucket(self) -> None:
        """Create the bucket if it doesn't exist (synchronous)."""
        if not self._client.bucket_exists(self._bucket):
            self._client.make_bucket(self._bucket)
            logger.info("Created bucket: %s", self._bucket)

    async def upload_object(
        self,
        path: str,
        data: bytes,
        content_type: str,
    ) -> None:
        """Upload an object to MinIO.

        Args:
            path: The object path/key in the bucket.
            data: The raw bytes to upload.
            content_type: The MIME content type (e.g., 'image/png').

        Raises:
            Exception: On upload failure.
        """
        await asyncio.to_thread(self._sync_upload, path, data, content_type)

    def _sync_upload(self, path: str, data: bytes, content_type: str) -> None:
        """Synchronous upload wrapped by asyncio.to_thread."""
        self._ensure_bucket()
        self._client.put_object(
            self._bucket,
            path,
            io.BytesIO(data),
            length=len(data),
            content_type=content_type,
        )
        logger.debug("Uploaded object: bucket=%s, path=%s, size=%d", self._bucket, path, len(data))

    async def generate_presigned_url(
        self,
        path: str,
        expiry_seconds: int,
    ) -> str:
        """Generate a presigned GET URL for an object.

        Args:
            path: The object path/key in the bucket.
            expiry_seconds: URL validity duration in seconds.

        Returns:
            A presigned URL string.

        Raises:
            Exception: On URL generation failure.
        """
        return await asyncio.to_thread(self._sync_presign, path, expiry_seconds)

    def _sync_presign(self, path: str, expiry_seconds: int) -> str:
        """Synchronous presigned URL generation wrapped by asyncio.to_thread."""
        url = self._client.presigned_get_object(
            self._bucket,
            path,
            expires=timedelta(seconds=expiry_seconds),
        )
        return url



class MinioLogoDownloader:
    """Downloads logo bytes from MinIO using the same client configuration.

    Implements the LogoDownloader protocol (async callable that returns bytes or None).
    """

    def __init__(self, storage_client: MinioStorageClient) -> None:
        self._storage = storage_client

    async def __call__(self, logo_url: str) -> bytes | None:
        """Download logo bytes from MinIO.

        The logo_url can be:
        - A full presigned URL (fetched via httpx)
        - A MinIO path like 'tenants/{tenant_id}/logo.png' (fetched via get_object)

        Returns:
            Logo bytes or None if download fails.
        """
        try:
            # If it's a relative path (not a full URL), fetch directly from MinIO
            if not logo_url.startswith("http"):
                return await asyncio.to_thread(
                    self._get_object_bytes, logo_url
                )

            # If it's a presigned URL, use httpx to download
            import httpx

            async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
                response = await client.get(logo_url)
                if response.status_code == 200:
                    return response.content
                logger.warning(
                    "Logo download failed: url=%s, status=%d",
                    logo_url[:100],
                    response.status_code,
                )
                return None
        except Exception as exc:
            logger.warning("Logo download error: %s", str(exc))
            return None

    def _get_object_bytes(self, path: str) -> bytes:
        """Synchronous download from MinIO bucket."""
        response = self._storage._client.get_object(
            self._storage._bucket, path
        )
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()
