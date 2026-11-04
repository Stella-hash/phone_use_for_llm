# social-feed-cursor v0.2 contract

Runtime: phone-use `android_activity_reading(eventId, previousEventId?)`.
Both IDs address existing completed phone observations; the previous ID must be
earlier. No latest-event guessing, global reading position, or subjective
"already read" state is stored. The cursor means text delivered in this chain.

The read is normally journaled as history without duplicating source text or
triggering a summary. If storage admission fails, saved reads remain available
with `historyReadNotRecorded=true`. It does not wake, inspect the current UI,
scroll, or call an API.
On review it may read the saved PNG from owner-only host storage; this is not a new
screenshot. A deleted image is reported without a replacement capture.

## Supported source boundaries

| Page | Source | Metadata |
| --- | --- | --- |
| Xiaohongshu note | Exactly one `com.xingin.xhs:id/imageNoteTextView` inside a note-detail observation with `noteDetailRoot` | `noteTitleTV`, `nickNameTV` |
| moomoo CA article | Text nodes in the single recorded WebView group, in an article observation with `media_detail_content_container` | `title_text`, `author_name_text` or `toolbar_user_name` |

Xiaohongshu may expose the caption before all of it appears in the viewport.
Return the text the app exposes. Do not filter it down to the visible lines.
Comment nodes, like counts and native navigation are excluded by source scope.

moomoo WebView text can include inline quote widgets as well as paragraphs.
The scope is named `article_webview`, not claimed to be perfectly segmented prose.
The UI parser's `webView` group records actual XML ancestry, not a bounding-box
guess. Nested WebView wrappers share their outermost group; sibling WebViews
remain distinct. Its integer is local to one dump, not a document identifier. Older dumps
without this field cannot establish this scope. A first unloaded WebView may
contain no text; later observations can expose it without any app setting change.

Private/password observations, unsupported layouts, ambiguous bodies, or source
text over 16,000 characters/160 blocks return review rather than silently cutting
the source. Original text is copied exactly; whitespace is normalized only for
comparison. OCR transcription and image content are not implemented in v0.2.

## Result semantics

- `new_text`: exact source blocks not already delivered after the matching anchor.
  The initial call returns all blocks. Changing live quote values ahead of an
  anchor are not appended as new article paragraphs.
- `overlap_anchor`: up to 120 characters copied from the matched source tail.
- `cursor_event_id`: last accepted source event. Review/backtracking retain it.
- `media_index`, `media_total`: independently observed one-based image number
  and total, from exactly one Xiaohongshu `imageNumberTextView` whose text is a
  valid positive `index/total` pair. `source.media_element_index` points to that
  node in `evidence_frame`. Missing, malformed or conflicting counters are null;
  they do not block valid text or inherit the previous frame's count. Counters
  can still be returned when caption text is unavailable. The text cursor may
  remain at an earlier event while media values describe the current event.
- `same_post`: derived from compatible app/source, matching author or title,
  and a unique source overlap of at least 48 normalized characters. Contradictory
  metadata returns false; insufficient evidence returns null. It is not a server
  post ID and cannot distinguish identical reposts by the same author.
- `scroll_result`: inferred movement of the matching text node in the two UI
  samples. Layout reflow can also move text. It is not an acknowledgement of a
  physical gesture or proof that animation has settled. It describes text, not
  the image carousel or an overall completion state. For example, text can be
  `backward` while `media_index=7` and `media_total=7`.
- `needs_review`, `issue`: unresolved continuity/source, with `evidence_frame`
  identifying the actual observation. A first seed is successful without a
  same-post comparison. Unknown identity is not silently converted to true.
- `source`: accessibility scope, sample time and element indices in the saved
  record. UI text and PNG capture occur sequentially, not at the same instant.

An ordered, unique suffix of the prior text must occur in the new observation.
Repeated short labels or ambiguous repeated paragraphs do not advance the cursor.
No overlap returns review; it does not prove a gap or a page change. A backward
window preserves the forward cursor. There is no inferred article-end flag or
screen-stable flag in this version.

## Decisions API boundary

The [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
returns typed choice/predicate/score judgments. Arbitrary `new_text` extraction
is not a choice judgment. The source extractor and overlap comparison therefore
own those fields. An eventual visual observer should receive evidence frames
and a fixed observable question, return unknown when unresolved, and leave text
copying and attention decisions outside that judgment. v0.2 sends no images or
article text to Decisions and requires no additional credential.
