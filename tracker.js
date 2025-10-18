const puppeteer = require("puppeteer");
const fse = require("fs-extra");
const path = require("path");
const Diff = require("diff");
const http = require("http");
const postcss = require("postcss");
const postcssNested = require("postcss-nested");

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

    const differences = Diff.diffLines(original, overridden);

    const lineChanges = [];
    console.log("\n--- Diff Output (Original vs Overridden) ---");
    differences.forEach((part) => {
      if (part.added) {
        part.value.split("\n").forEach(line => {
          if (line.trim() !== '') {
            console.log(`+ ${line}`);
            lineChanges.push({ type: "added", value: line });
          }
        });
      } else if (part.removed) {
        part.value.split("\n").forEach(line => {
          if (line.trim() !== '') {
            console.log(`- ${line}`);
            lineChanges.push({ type: "removed", value: line });
          }
        });
      }
    });
    console.log("--- End of Diff ---");

    // Write line changes to JSON file
    const jsonOutputPath = path.join(dataDir, "line_changes.json");
    await fse.writeFile(jsonOutputPath, JSON.stringify(lineChanges, null, 2), "utf8");
    console.log(`Line changes written to ${jsonOutputPath}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
