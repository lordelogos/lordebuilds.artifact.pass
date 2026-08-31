# Hostile HTML staging check

Upload `hostile-preview.html` through the staging homepage and create a 15-minute link.

The rendered preview should show the designed test page, but:

- the browser must remain on the ArtifactPass share URL;
- the unsafe link must not navigate;
- the form fields and submit button must be disabled;
- no external image, audio, frame, object, stylesheet, or background should load;
- no popup, redirect, script message, or visible script-generated content should appear.

The **Source** view and **Download** action must still contain the untouched hostile file. That exact preservation is intentional. Only the rendered preview is neutralized.

If any active behavior runs, close the page and treat the release candidate as failed.
