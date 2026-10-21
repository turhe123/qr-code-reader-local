# QR Code Reader from Image — specification

**Tagline:** Drop a screenshot or photo and read the QR code inside it in your browser, or scan with your camera, no upload.

**Category:** Data & Files

**Free alternative to:** ZXing Decoder Online, WebQR and online QR scanners (many upload your image to a server, require a camera permission, ads, and fail on rotated or small codes)

**Search phrases:** qr code reader online, scan qr code from image, decode qr code from screenshot, read qr code from photo, qr code scanner online, what does this qr code say

**Allowed libraries:** jsqr

**Published at:** https://turhe123.github.io/qr-code-reader-local/

## Acceptance checks (each must have a test)

- dropping sample-qr.png shows the decoded menu link text
- the decoded URL is shown as plain text and is not opened automatically
- dropping an image without a QR code shows a no code found message
- the Copy button copies the decoded text
- pasting an image from the clipboard also decodes it
- works at 390px wide

## Spec

Search demand: qr code reader online, scan qr code from image and decode qr code from screenshot are searched by people who received a QR code as a picture or screenshot, often on a desktop with no phone camera at hand, and who want to see where it leads before opening it. Many decoder sites upload the image to a server, wrap results in ads, require camera access for no reason, or open the destination automatically, which is risky given QR phishing. The safe habit is to read the text first.

Our version does one job: decode QR codes from images locally and show the raw content safely. Features: drop an image, choose a file, paste an image from the clipboard, or switch to live camera scanning using the rear camera where available. The result shows the decoded text exactly, a detected type label (link, Wi-Fi network, email, phone, contact card, plain text) with the fields parsed into a readable table (for Wi-Fi: network name, security, password with a reveal toggle), a link shown with its domain highlighted and a warning for lookalike characters or non-Latin lookalike domains, and buttons to copy and to open a link only after an explicit confirm click. Multiple codes in one image are found by scanning tiles and listing each distinct result.

UI: a drop zone and a paste hint above the fold, plus a Use camera button. After decoding, the left shows the image with a rectangle drawn over the detected code, and the right shows the decoded content card. A history is deliberately not stored. Empty state explains that images stay on the device. Error state says no QR code was found and gives tips: crop closer, increase contrast, avoid glare. Keyboard: Control or Command plus V pastes an image, and Enter on the Copy button copies.

Technical approach: load the image via createImageBitmap honoring EXIF orientation, draw it to a canvas, get ImageData, and run the allowed jsqr library with inversion attempts enabled. When no code is found, retry with downscaled and upscaled versions, simple contrast stretching, and tiles of the image at half and quarter size to catch small codes and several codes. For live camera mode use getUserMedia, draw video frames to a canvas about ten times per second via requestAnimationFrame throttling, decode each frame, stop the stream as soon as a code is read and when the page is hidden, and show a clear permission denied message. Parsing of Wi-Fi, mailto, tel, SMSTO and vCard payloads is done with small hand-written parsers. Only barcodes of QR type are supported, which is stated plainly.

Edge cases: huge photos over 12 megapixels are downscaled before scanning for speed and memory HEIC images are not supported and a helpful message says to convert first camera is unavailable on non-secure pages so a fallback message appears the result text is always inserted with textContent, never as markup binary payloads are shown as hex mirrored or inverted codes are handled by the inversion attempts mobile Safari requires a user gesture to start the camera.

Demo data: a bundled sample image of a QR code that encodes a fictional restaurant menu link on example dot org, plus a second sample encoding the Wi-Fi network LanternGuest.
