const puppeteer = require("puppeteer");
const fse = require("fs-extra");
const path = require("path");
const Diff = require("diff");
const postcss = require("postcss");
const postcssNested = require("postcss-nested");
const selectorParser = require("postcss-selector-parser");
const { parseMediaQuery, stringify } = require("media-query-parser");
const readline = require("readline"); // Add readline for CLI interaction

const PAGE_NAME = "about"; // New constant for the page name
const LOCAL_PORT = "4325"; // New constant for the localhost port

// Function to extract content within <style> tags
function extractStyleContent(htmlContent) {
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  let allStyleContent = "";
  while ((match = styleRegex.exec(htmlContent)) !== null) {
    allStyleContent += match[1].trim() + "\n";
  }
  return allStyleContent.trim();
}

const overridesPath = `C:\\Users\\hossa\\Desktop\\ariva-overrides\\localhost%3A${LOCAL_PORT}\\${PAGE_NAME}${
  PAGE_NAME === "index" ? ".html" : ""
}`;
const dataDir = path.join(__dirname, "data");
const originalPath = path.join(dataDir, `${PAGE_NAME}_original.css`);
const overriddenPath = path.join(dataDir, `${PAGE_NAME}_overridden.css`);
const responsiveChangesPath = path.join(dataDir, "responsive_changes.json");

let browser;
let page;
let isRecording = false;
let currentSessionType = null; // 'default' or 'media'

async function initializePuppeteer() {
  browser = await puppeteer.launch();
  page = await browser.newPage();

  // Now navigate
  await page.goto(
    `http://localhost:${LOCAL_PORT}/${PAGE_NAME === "index" ? "" : PAGE_NAME}`,
    { waitUntil: "networkidle0" }
  );

  console.log(
    `Tracker initialized. Puppeteer browser launched at http://localhost:${LOCAL_PORT}.`
  );
  console.log("Interact with the script via this CLI.");
}

async function captureAndFlattenStyles(outputPath) {
  const htmlContent = await page.content();
  const styleContent = extractStyleContent(htmlContent);

  try {
    const processed = await postcss([postcssNested]).process(styleContent, {
      from: undefined,
    });
    await fse.writeFile(outputPath, processed.root.toString(), "utf8");
  } catch (error) {
    if (error.name === "CssSyntaxError") {
      const lines = styleContent.split("\n");
      const lineNumber = error.line;
      const problematicLine = lines[lineNumber - 1];
      console.error(
        `CSS Syntax Error at line ${lineNumber}: "${problematicLine}"`
      );
      console.error(`Column: ${error.column}, Reason: ${error.reason}`);
      console.error("Full CSS content that caused the error:");
      console.error("```css\n" + overriddenStyleContent + "\n```");
    }
    throw error;
  }
}

async function processOverriddenStyles() {
  if (!(await fse.pathExists(overridesPath))) {
    throw new Error(
      `Overrides file not found at ${overridesPath}. Make sure changes are saved in DevTools.`
    );
  }
  // Read the overridden HTML from the file system
  const overriddenHtmlContent = await fse.readFile(overridesPath, "utf8");
  const overriddenStyleContent = extractStyleContent(overriddenHtmlContent);

  try {
    // Flatten and write to overriddenPath
    const processedOverridden = await postcss([postcssNested]).process(
      overriddenStyleContent,
      { from: undefined }
    );
    await fse.writeFile(
      overriddenPath,
      processedOverridden.root.toString(),
      "utf8"
    );
    console.log("Overridden styles saved and flattened.");
  } catch (error) {
    if (error.name === "CssSyntaxError") {
      const lines = overriddenStyleContent.split("\n");
      const lineNumber = error.line;
      const problematicLine = lines[lineNumber - 1];
      console.error(
        `CSS Syntax Error at line ${lineNumber}: "${problematicLine}"`
      );
      console.error(`Column: ${error.column}, Reason: ${error.reason}`);

      // Log 5 lines before and 5 lines after the error line
      const startLine = Math.max(0, lineNumber - 6); // 5 lines before + 1 for 0-indexed
      const endLine = Math.min(lines.length, lineNumber + 5); // 5 lines after
      const contextLines = lines.slice(startLine, endLine);

      console.error("\n--- CSS Context Around Error (Lines " + (startLine + 1) + "-" + endLine + ") ---");
      contextLines.forEach((line, index) => {
        const currentLineNumber = startLine + index + 1;
        const prefix = currentLineNumber === lineNumber ? ">>> " : "    ";
        console.error(`${prefix}${currentLineNumber}: ${line}`);
      });
      console.error("--------------------------------------------------\n");
    }
    throw error;
  }
}

async function performDiffAndFilter(
  originalCssPath,
  overriddenCssPath,
  debugOutput = false
) {
  const originalCssRaw = await fse.readFile(originalCssPath, "utf8");
  const overriddenCssRaw = await fse.readFile(overriddenCssPath, "utf8");

  // Re-process both CSS strings through PostCSS to ensure consistent formatting
  let processedOriginal, processedOverridden;
  try {
    processedOriginal = await postcss([postcssNested]).process(originalCssRaw, {
      from: undefined,
    });
    processedOverridden = await postcss([postcssNested]).process(
      overriddenCssRaw,
      { from: undefined }
    );
  } catch (error) {
    if (error.name === "CssSyntaxError") {
      const cssContent =
        error.line && error.line <= originalCssRaw.split("\n").length
          ? originalCssRaw
          : overriddenCssRaw;
      const lines = cssContent.split("\n");
      const lineNumber = error.line;
      const problematicLine = lines[lineNumber - 1];
      console.error(
        `CSS Syntax Error at line ${lineNumber}: "${problematicLine}"`
      );
      console.error(`Column: ${error.column}, Reason: ${error.reason}`);
    }
    throw error;
  }

  const originalCss = processedOriginal.root.toString();
  const overriddenCss = processedOverridden.root.toString();

  let originalRoot, overriddenRoot;
  try {
    originalRoot = postcss.parse(originalCss);
    overriddenRoot = postcss.parse(overriddenCss);
  } catch (error) {
    if (error.name === "CssSyntaxError") {
      const cssContent =
        error.line && error.line <= originalCss.split("\n").length
          ? originalCss
          : overriddenCss;
      const lines = cssContent.split("\n");
      const lineNumber = error.line;
      const problematicLine = lines[lineNumber - 1];
      console.error(
        `CSS Syntax Error at line ${lineNumber}: "${problematicLine}"`
      );
      console.error(`Column: ${error.column}, Reason: ${error.reason}`);
    }
    throw error;
  }

  const changedProperties = [];

  // Function to get media query from a node
  function getMediaQuery(node) {
    let parent = node.parent;
    while (parent) {
      if (parent.type === "atrule" && parent.name === "media") {
        return parent.params;
      }
      parent = parent.parent;
    }
    return null;
  }

  // Helper to normalize selector for comparison
  function normalizeSelector(selector) {
    return selectorParser().astSync(selector).toString();
  }

  // Helper to normalize media query for comparison
  function normalizeMediaQuery(mediaQuery) {
    if (!mediaQuery) return null;
    const parsed = parseMediaQuery(mediaQuery);
    if (parsed && parsed.condition) {
      return stringify(parsed.condition);
    }
    return mediaQuery; // Fallback to original if parsing fails
  }

  // Map original rules for easier lookup
  const originalRulesMap = new Map(); // Key: `${normalizedSelector}@@${normalizedMediaQuery}`, Value: originalRule
  originalRoot.walkRules((rule) => {
    const normalizedSelector = normalizeSelector(rule.selector);
    const normalizedMediaQuery = normalizeMediaQuery(getMediaQuery(rule));
    const key = `${normalizedSelector}@@${normalizedMediaQuery}`;
    originalRulesMap.set(key, rule);
  });

  // Compare rules and their declarations
  overriddenRoot.walkRules((overriddenRule) => {
    const normalizedOverriddenSelector = normalizeSelector(
      overriddenRule.selector
    );
    const normalizedOverriddenMediaQuery = normalizeMediaQuery(
      getMediaQuery(overriddenRule)
    );
    const key = `${normalizedOverriddenSelector}@@${normalizedOverriddenMediaQuery}`;

    const originalRule = originalRulesMap.get(key);

    if (originalRule) {
      // Rule exists in both, compare declarations
      const originalDeclsMap = new Map();
      originalRule.walkDecls((decl) => {
        originalDeclsMap.set(decl.prop, decl);
      });

      overriddenRule.walkDecls((overriddenDecl) => {
        const originalDecl = originalDeclsMap.get(overriddenDecl.prop);
        if (overriddenDecl.type === "comment" && originalDecl) {
          // If overridden declaration is a comment, treat as removed
          changedProperties.push({
            oldProperty: `${originalDecl.prop}: ${originalDecl.value};`,
            newProperty: null,
            cssSelector: overriddenRule.selector,
            mediaQuery: getMediaQuery(overriddenRule),
          });
        } else if (!originalDecl) {
          // Added declaration
          changedProperties.push({
            oldProperty: null,
            newProperty: `${overriddenDecl.prop}: ${overriddenDecl.value};`,
            cssSelector: overriddenRule.selector,
            mediaQuery: getMediaQuery(overriddenRule),
          });
        } else if (originalDecl.value !== overriddenDecl.value) {
          // Modified declaration
          changedProperties.push({
            oldProperty: `${originalDecl.prop}: ${originalDecl.value};`,
            newProperty: `${overriddenDecl.prop}: ${overriddenDecl.value};`,
            cssSelector: overriddenRule.selector,
            mediaQuery: getMediaQuery(overriddenRule),
          });
        }
        originalDeclsMap.delete(overriddenDecl.prop); // Mark as processed
      });

      // Any remaining in originalDeclsMap were removed
      originalDeclsMap.forEach((originalDecl) => {
        changedProperties.push({
          oldProperty: `${originalDecl.prop}: ${originalDecl.value};`,
          newProperty: null,
          cssSelector: originalRule.selector,
          mediaQuery: getMediaQuery(originalRule),
        });
      });
      originalRulesMap.delete(key); // Mark original rule as processed
    } else {
      // Entirely new rule in overriddenRoot
      overriddenRule.walkDecls((overriddenDecl) => {
        changedProperties.push({
          oldProperty: null,
          newProperty: `${overriddenDecl.prop}: ${overriddenDecl.value};`,
          cssSelector: overriddenRule.selector,
          mediaQuery: getMediaQuery(overriddenRule),
        });
      });
    }
  });

  // Any remaining in originalRulesMap were entirely removed rules
  originalRulesMap.forEach((originalRule) => {
    originalRule.walkDecls((originalDecl) => {
      changedProperties.push({
        oldProperty: `${originalDecl.prop}: ${originalDecl.value};`,
        newProperty: null,
        cssSelector: originalRule.selector,
        mediaQuery: getMediaQuery(originalRule),
      });
    });
  });

  // Filter changes using line-based diff
  const lineDifferences = Diff.diffLines(originalCss, overriddenCss);

  if (debugOutput) {
    await fse.writeFile(
      path.join(dataDir, "diff.txt"),
      JSON.stringify(lineDifferences, null, 2),
      "utf8"
    );
  }

  const changedLines = new Set();

  // Helper to normalize a CSS line for comparison
  function normalizeCssLine(line) {
    return line.trim().replace(/\s+/g, " ").toLowerCase();
  }

  lineDifferences.forEach((part) => {
    if (part.added || part.removed) {
      part.value.split("\n").forEach((line) => {
        const normalizedLine = normalizeCssLine(line);
        if (normalizedLine !== "") {
          changedLines.add(normalizedLine);
        }
      });
    }
  });

  const filteredChangedProperties = changedProperties.filter((change) => {
    const normalizedOldProp = change.oldProperty
      ? normalizeCssLine(change.oldProperty)
      : null;
    const normalizedNewProp = change.newProperty
      ? normalizeCssLine(change.newProperty)
      : null;

    const oldPropMatches =
      normalizedOldProp && changedLines.has(normalizedOldProp);
    const newPropMatches =
      normalizedNewProp && changedLines.has(normalizedNewProp);

    return oldPropMatches || newPropMatches;
  });

  if (debugOutput) {
    await fse.writeFile(
      path.join(dataDir, "parsedChanges.txt"),
      JSON.stringify(changedProperties, null, 2),
      "utf8"
    );
  }

  return filteredChangedProperties;
}

async function recordDefault() {
  if (isRecording) {
    console.log(
      "Warning: A recording session is already active. Please call finishDefault() or finishMedia() first."
    );
    return;
  }
  isRecording = true;
  currentSessionType = "default";
}

async function finishDefault() {
  if (!isRecording || currentSessionType !== "default") {
    console.log(
      "Error: No default recording session active. Call recordDefault() first."
    );
    return;
  }
  console.log("Finishing default style changes...");

  await processOverriddenStyles();

  const filteredChanges = await performDiffAndFilter(
    originalPath,
    overriddenPath
  );

  // Append to changed_properties.json
  let existingChanges = [];
  if (await fse.pathExists(path.join(dataDir, "changed_properties.json"))) {
    existingChanges = JSON.parse(
      await fse.readFile(path.join(dataDir, "changed_properties.json"), "utf8")
    );
  }
  existingChanges.push(...filteredChanges);
  await fse.writeFile(
    path.join(dataDir, "changed_properties.json"),
    JSON.stringify(existingChanges, null, 2),
    "utf8"
  );
  console.log(
    `Default changes written to ${path.join(
      dataDir,
      "changed_properties.json"
    )}`
  );

  // Update baseline
  await fse.copy(overriddenPath, originalPath);
  await fse.remove(overriddenPath);
  console.log(
    `Baseline updated: ${PAGE_NAME}_overridden.css is now ${PAGE_NAME}_original.css`
  );

  isRecording = false;
  currentSessionType = null;
}

async function recordMedia() {
  if (isRecording) {
    console.log(
      "Warning: A recording session is already active. Please call finishDefault() or finishMedia() first."
    );
    return;
  }
  isRecording = true;
  currentSessionType = "media";
  console.log("Recording media query style changes...");
  await page.reload({ waitUntil: "networkidle0" }); // Reload page to reflect latest baseline
}

async function finishMedia(mediaQueryString) {
  if (!isRecording || currentSessionType !== "media") {
    console.log(
      "Error: No media query recording session active. Call recordMedia() first."
    );
    return;
  }
  if (!mediaQueryString || typeof mediaQueryString !== "string") {
    console.log(
      "Error: finishMedia requires a media query string argument (e.g., finishMedia('>900px'))."
    );
    return;
  }

  console.log(
    `Finishing media query style changes for: ${mediaQueryString}...`
  );

  await processOverriddenStyles();

  const filteredChanges = await performDiffAndFilter(
    originalPath,
    overriddenPath,
    false
  ); // Set debugOutput to false

  const responsiveChanges = filteredChanges.map((change) => {
    const defaultStyle = change.oldProperty
      ? {
          [change.oldProperty.split(":")[0].trim()]: change.oldProperty
            .split(":")[1]
            .trim()
            .slice(0, -1),
        }
      : null;
    const responsiveStyle = change.newProperty
      ? {
          [change.newProperty.split(":")[0].trim()]: change.newProperty
            .split(":")[1]
            .trim()
            .slice(0, -1),
        }
      : change.oldProperty
      ? "initial"
      : null;

    return {
      selector: change.cssSelector,
      defaultStyle: defaultStyle,
      responsiveStyle: responsiveStyle,
    };
  });

  // Append to responsive_changes.json
  let existingResponsiveChanges = [];
  if (await fse.pathExists(responsiveChangesPath)) {
    existingResponsiveChanges = JSON.parse(
      await fse.readFile(responsiveChangesPath, "utf8")
    );
  }
  existingResponsiveChanges.push({
    mediaMatch: mediaQueryString,
    changes: responsiveChanges,
  });
  await fse.writeFile(
    responsiveChangesPath,
    JSON.stringify(existingResponsiveChanges, null, 2),
    "utf8"
  );
  console.log(`Responsive changes written to ${responsiveChangesPath}`);

  // Update baseline
  await fse.copy(overriddenPath, originalPath);
  await fse.remove(overriddenPath);
  console.log(
    `Baseline updated: ${PAGE_NAME}_overridden.css is now ${PAGE_NAME}_original.css`
  );

  isRecording = false;
  currentSessionType = null;
}

async function quit() {
  if (browser) {
    await browser.close();
  }

  // Delete all .css and .txt files in the data folder
  const filesIn_dataDir = await fse.readdir(dataDir);
  for (const file of filesIn_dataDir) {
    if (file.endsWith(".css") || file.endsWith(".txt")) {
      await fse.remove(path.join(dataDir, file));
    }
  }
  console.log("Tracker quit. CSS and TXT files in data folder deleted.");
  process.exit(0);
}

async function main() {
  try {
    // Cleanup: Delete contents of data folder and overrides folder
    console.log("Cleaning up data and overrides folders...");
    await fse.emptyDir(dataDir);
    await fse.emptyDir("C:\\Users\\hossa\\Desktop\\ariva-overrides\\");
    console.log("Cleanup complete.");

    await fse.ensureDir(dataDir);

    // Initial capture of original styles
    await initializePuppeteer();
    await captureAndFlattenStyles(originalPath);
    console.log("Initial original styles snapshot complete.");

    // Setup readline interface for CLI interaction
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.prompt();

    rl.on("line", async (line) => {
      const command = line.trim();
      if (command === "RD") {
        await recordDefault();
      } else if (command === "FD") {
        await finishDefault();
      } else if (command === "RM") {
        await recordMedia();
      } else if (command.startsWith("FM(") && command.endsWith(")")) {
        const mediaQueryString = command
          .substring("FM(".length, command.length - 1)
          .trim(); // Extract string inside parentheses
        await finishMedia(mediaQueryString);
      } else if (command === "quit()") {
        await quit();
        rl.close();
      } else {
        console.log(`Unknown command: ${command}`);
      }
      rl.prompt();
    }).on("close", () => {
      console.log("Exiting tracker CLI.");
      process.exit(0);
    });
  } catch (error) {
    console.error("Error:", error.message);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();
