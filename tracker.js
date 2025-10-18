const puppeteer = require("puppeteer");
const fse = require("fs-extra");
const path = require("path");
const Diff = require("diff"); // Re-import Diff
const http = require("http");
const postcss = require("postcss");
const postcssNested = require("postcss-nested");
const selectorParser = require("postcss-selector-parser");
const { parseMediaQuery, stringify } = require("media-query-parser");

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

const overridesPath =
  "C:\\Users\\hossa\\Desktop\\ariva-overrides\\localhost%3A4325\\index.html";
const dataDir = path.join(__dirname, "data");
const originalPath = path.join(dataDir, "index_original.css");
const overriddenPath = path.join(dataDir, "index_overridden.css");

async function main() {
  try {
    // Cleanup: Delete contents of data folder and overrides folder
    console.log("Cleaning up data and overrides folders...");
    await fse.emptyDir(dataDir);
    await fse.emptyDir("C:\\Users\\hossa\\Desktop\\ariva-overrides\\");
    console.log("Cleanup complete.");

    await fse.ensureDir(dataDir);

    // Step 1: Capture original HTML with Puppeteer
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto("http://localhost:4325", { waitUntil: "networkidle0" });
    const htmlContent = await page.content();
    const styleContent = extractStyleContent(htmlContent);
    await fse.writeFile(originalPath, styleContent, "utf8");
    console.log("Original styles snapshot complete");
    await browser.close();

    // Step 2 & 3: Wait for signal from user via HTTP
    const signalPort = 3000;
    console.log(
      "Now, open your browser to http://localhost:4325, enable local overrides, and make your style changes."
    );
    console.log("When done, run this in the browser console:");
    console.log(`fetch('http://localhost:${signalPort}/done')`);

    await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        // Add CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === "/done") {
          res.end("Signal received. Processing...");
          resolve();
          server.close();
        } else {
          res.end();
        }
      });
      server.listen(signalPort, () => {
        console.log(
          `Listening for completion signal on http://localhost:${signalPort}/done`
        );
      });
    });

    // Step 3: Copy overridden HTML
    if (!(await fse.pathExists(overridesPath))) {
      throw new Error(
        `Overrides file not found at ${overridesPath}. Make sure changes are saved.`
      );
    }
    // Read the overridden HTML, extract styles, and save as .css
    const overriddenHtmlContent = await fse.readFile(overridesPath, "utf8");
    const overriddenStyleContent = extractStyleContent(overriddenHtmlContent);
    await fse.writeFile(overriddenPath, overriddenStyleContent, "utf8");
    console.log("Overridden styles saved.");

    // Step 4: Flatten CSS with PostCSS and then run diff
    let original = await fse.readFile(originalPath, "utf8");
    let overridden = await fse.readFile(overriddenPath, "utf8");

    const processedOriginal = await postcss([postcssNested]).process(original, { from: undefined });
    original = processedOriginal.root.toString();
    await fse.writeFile(originalPath, original, "utf8");
    console.log("Original CSS flattened and updated:", originalPath);

    const processedOverridden = await postcss([postcssNested]).process(overridden, { from: undefined });
    overridden = processedOverridden.root.toString();
    await fse.writeFile(overriddenPath, overridden, "utf8");
    console.log("Overridden CSS flattened and updated:", overriddenPath);

    const originalRoot = postcss.parse(original);
    const overriddenRoot = postcss.parse(overridden);

    const changedProperties = [];

    // Function to get media query from a node
    function getMediaQuery(node) {
      let parent = node.parent;
      while (parent) {
        if (parent.type === 'atrule' && parent.name === 'media') {
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
      // Check for parsing errors as per documentation
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
      const normalizedOverriddenSelector = normalizeSelector(overriddenRule.selector);
      const normalizedOverriddenMediaQuery = normalizeMediaQuery(getMediaQuery(overriddenRule));
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
          if (overriddenDecl.type === 'comment' && originalDecl) {
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

    // Step 5: Filter changes using line-based diff
    const lineDifferences = Diff.diffLines(original, overridden);
    const changedLines = new Set();

    lineDifferences.forEach((part) => {
      if (part.added || part.removed) {
        part.value.split('\n').forEach(line => {
          const trimmedLine = line.trim();
          if (trimmedLine !== '') {
            changedLines.add(trimmedLine);
          }
        });
      }
    });

    const filteredChangedProperties = changedProperties.filter(change => {
      const oldPropMatches = change.oldProperty && changedLines.has(change.oldProperty.trim());
      const newPropMatches = change.newProperty && changedLines.has(change.newProperty.trim());
      return oldPropMatches || newPropMatches;
    });

    // Write filtered changed properties to JSON file
    const jsonOutputPath = path.join(dataDir, "changed_properties.json");
    await fse.writeFile(jsonOutputPath, JSON.stringify(filteredChangedProperties, null, 2), "utf8");
    console.log(`Filtered changed properties written to ${jsonOutputPath}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
