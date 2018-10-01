/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Github } from "./github";
import { Logger } from "./logger";
import { ProjectConfig, PageContent, PageSection, ProjectPage } from "./types";

const admin = require("firebase-admin");
const cheerio = require("cheerio");
const cjson = require("comment-json");
const functions = require("firebase-functions");
const marked = require("marked");
const path = require("path");
const url = require("url");
const urljoin = require("url-join");

const github = new Github();
const log = new Logger();

// Initialize the Admin SDK with the right credentials for the environment
try {
  admin.initializeApp(functions.config().firebase);
} catch (e) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

// Initialize marked with options
marked.setOptions({
  renderer: new marked.Renderer(),
  gfm: true,
  tables: true,
  breaks: false
});

const db = admin.firestore();
db.settings({ timestampsInSnapshots: true });

const ADDITIONAL_PROJECTS_URL = github.getRawContentUrl(
  "firebase",
  "firebaseopensource.com",
  "config/additional_projects.json"
);

const FEATURED_BLACKLIST_PROJECTS_URL = github.getRawContentUrl(
  "firebase",
  "firebaseopensource.com",
  "config/feature_blacklist_projects.json"
);

/**
 * Global lists, see loadGlobalConfig()
 */
let ADDITIONAL_PROJECTS: string[] = [];
let FEATURED_BLACKLIST_PROJECTS: string[] = [];

export class Project {
  /**
   * Load globally relevant blacklists and whitelists.
   */
  loadGlobalConfig = async function() {
    if (
      ADDITIONAL_PROJECTS.length > 0 &&
      FEATURED_BLACKLIST_PROJECTS.length > 0
    ) {
      return;
    }

    const additionalData = await github.getContent(ADDITIONAL_PROJECTS_URL);
    ADDITIONAL_PROJECTS = JSON.parse(additionalData).projects;

    const blacklistData = await github.getContent(
      FEATURED_BLACKLIST_PROJECTS_URL
    );
    FEATURED_BLACKLIST_PROJECTS = JSON.parse(blacklistData).projects;
  };

  /**
   * Get a list of all project IDs, useful for fan-out project storing.
   */
  listAllProjectIds = async function() {
    // Loads ADDITIONAL_PROJECTS
    await this.loadGlobalConfig();

    const repos = await github.listAllRepos("firebase");
    const ids = repos.map(repo => {
      return this.pathToSlug(repo);
    });

    const allIds = ids.concat(ADDITIONAL_PROJECTS);
    return allIds;
  };

  /**
   * Store a project and all of its pages.
   */
  recursiveStoreProject(id: string) {
    log.debug(id, "recursiveStoreProject()");

    const that = this;
    return this.loadGlobalConfig()
      .then(() => {
        return that.getProjectConfig(id);
      })
      .then(config => {
        // Store this project's config and content
        const storeConfig = that.storeProjectConfig(id, config);
        const storeContent = that.storeProjectContent(id, config);

        // Wait for both to complete then pass on config
        return Promise.all([storeConfig, storeContent]);
      })
      .catch(e => {
        log.error(id, "recursiveStoreProject failed", e);
      });
  }

  /**
   * Make sure all IDs have the same casing, etc.f
   */
  normalizeId(id: string) {
    return id.toLowerCase();
  }

  /**
   * Convert a path with slashes to a slug.
   */
  pathToSlug(path: string) {
    return this.normalizeId(path.replace(/\//g, "::"));
  }

  /**
   * Guess the platforms for a project.
   */
  inferPlatforms(id: string) {
    const platforms: any = {
      ios: ["ios", "objc", "swift", "apple"],
      android: ["android", "kotlin"],
      web: ["web", "js", "angular", "react"],
      games: ["cpp", "unity"]
    };

    const result: any = {};

    for (let key in platforms) {
      const keywords = platforms[key] as string[];
      keywords.forEach(keyword => {
        if (id.indexOf(keyword) >= 0) {
          result[key] = true;
        }
      });
    }

    return result;
  }

  /**
   * Get the configuration for a project at a certain path.
   */
  getProjectConfig(id: string) {
    const url = this.getConfigUrl(id);
    const idParsed = this.parseProjectId(id);

    const that = this;
    return this.checkConfigExists(id)
      .then((exists: boolean) => {
        if (exists) {
          // Config exists, fetch and parse it
          return github.getContent(url).then(data => {
            // Parse and remove comments
            const contents = data.toString();
            return cjson.parse(contents, null, true);
          });
        } else {
          // If the project has no config, make one up
          log.debug(id, "WARN: Using default config.");
          return github
            .getRepoReadmeFile(idParsed.owner, idParsed.repo)
            .then((readme: string) => {
              log.debug(id, `README: ${readme}`);
              return {
                name: idParsed.repo,
                type: "library",
                content: readme
              };
            });
        }
      })
      .then(config => {
        // Add inferred platforms
        if (!config.platforms) {
          config.platforms = that.inferPlatforms(id);
        }

        // Consult the feature blacklist
        if (FEATURED_BLACKLIST_PROJECTS.indexOf(id) >= 0) {
          config.blacklist = true;
        } else {
          config.blacklist = false;
        }

        // Merge the config with repo metadata like stars
        // and updated time.
        return github
          .getRepoMetadata(idParsed.owner, idParsed.repo)
          .then(meta => {
            if (meta.description) {
              config.description = meta.description;
            }

            config.fork = meta.fork;
            config.stars = meta.stars;
            config.last_updated = meta.last_updated;

            return config;
          });
      })
      .then(config => {
        return that.arraysToMaps(config);
      });
  }

  /**
   * Check if the config exists for a given project.
   */
  checkConfigExists(id: string) {
    const url = this.getConfigUrl(id);
    return github.pageExists(url);
  }

  /**
   * Get the githubusercontent base URL for a repo.
   */
  getRawContentBaseUrl(id: string) {
    // Parse the ID into pieces
    const idObj = this.parseProjectId(id);

    // Get the URL to the root folder
    const pathPrefix = idObj.path ? idObj.path + "/" : "";

    return github.getRawContentUrl(idObj.owner, idObj.repo, pathPrefix);
  }

  /**
   * Get the base github URL for a project.
   */
  getRenderedContentBaseUrl(id: string) {
    // Parse the ID into pieces
    const idObj = this.parseProjectId(id);

    // Get the URL to the root folder
    const pathPrefix = idObj.path ? idObj.path + "/" : "";
    const url = `https://github.com/${idObj.owner}/${idObj.repo}/tree/master/${
      pathPrefix
    }`;

    return url;
  }

  /**
   * Get the URL to the config for a particular project ID.
   */
  getConfigUrl(id: string) {
    return urljoin(this.getRawContentBaseUrl(id), ".opensource/project.json");
  }

  /**
   * Get the URL to the content for a particular project ID.
   */
  getContentUrl(id: string, config: ProjectConfig) {
    // Path to content, relative to the project
    const contentPath = config.content;
    return urljoin(this.getRawContentBaseUrl(id), contentPath);
  }

  /**
   * Get the URL for the raw content for a page.
   */
  getPageUrl(id: string, page: string) {
    return urljoin(this.getRawContentBaseUrl(id), page);
  }

  /**
   * Fetch a project config and put it into Firestore.
   */
  storeProjectConfig(id: string, config: ProjectConfig) {
    const data = config;
    const docId = this.normalizeId(id);

    // Add server timestamp
    data.last_fetched = admin.firestore.FieldValue.serverTimestamp();

    log.debug(id, `Storing at /configs/${docId}`);
    const configProm = db
      .collection("configs")
      .doc(docId)
      .set(data);

    return configProm;
  }

  /**
   * Fetch a project's content and put it into Firestore.
   */
  storeProjectContent(id: string, config: ProjectConfig) {
    var that = this;
    const contentRef = db.collection("content").doc(this.normalizeId(id));

    return this.getProjectContent(id, config)
      .then(sections => {
        // Set main content
        return contentRef.set(sections);
      })
      .then(() => {
        // Set all pages in subcollection
        return that.getProjectPagesContent(id, config).then(content => {
          if (!content || !content.pages) {
            return Promise.resolve();
          }

          const batch = db.batch();

          content.pages.forEach((page: ProjectPage) => {
            const slug = that.pathToSlug(page.name).toString();
            const ref = contentRef.collection("pages").doc(slug);

            log.debug(id, `Storing ${page.name} content at path ${ref.path}`);
            batch.set(ref, page.content);
          });

          return batch.commit();
        });
      });
  }

  /**
   * Fetch a project's content.
   */
  getProjectContent(id: string, config: ProjectConfig) {
    const url = this.getContentUrl(id, config);

    var that = this;
    return github
      .getContent(url)
      .then(data => {
        return marked(data);
      })
      .then(html => {
        return that.sanitizeHtml(id, undefined, config, html);
      })
      .then(html => {
        return that.htmlToSections(html);
      })
      .then(content => {
        content.sections = that.filterProjectSections(content.sections);
        return content;
      });
  }

  /**
   * Filter sections that are not useful when rendered.
   */
  filterProjectSections(sections: PageSection[]) {
    const blacklist = [
      "license",
      "licensing",
      "contribute",
      "contributing",
      "build status"
    ];

    return sections.filter(section => {
      if (!section.name) {
        return true;
      }

      for (let i = 0; i < blacklist.length; i++) {
        if (blacklist[i] === section.name.toLowerCase().trim()) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get the content for all pages of a project.
   */
  getProjectPagesContent(id: string, config: ProjectConfig): Promise<any> {
    if (!config.pages || Object.keys(config.pages).length == 0) {
      log.debug(id, `Project has no extra pages.`);
      return Promise.resolve({});
    }

    log.debug(id, `Getting page content for extra pages.`);

    const promises: any[] = [];
    const pages: ProjectPage[] = [];

    // Loop through pages, get content for each
    const that = this;
    Object.keys(config.pages).forEach(page => {
      const pageUrl = that.getPageUrl(id, page);
      log.debug(id, `Rendering page: ${pageUrl}`);

      const pagePromise = github
        .getContent(pageUrl)
        .then(data => {
          return marked(data);
        })
        .then(html => {
          return that.sanitizeHtml(id, page, config, html);
        })
        .then(html => {
          pages.push({
            name: page,
            content: that.htmlToSections(html)
          });
        });

      promises.push(pagePromise);
    });

    return Promise.all(promises).then(() => {
      return {
        pages
      };
    });
  }

  /**
   * Change href to lowercase.
   */
  lowercaseLink(el: any) {
    const newVal = el.attribs["href"].toLowerCase();
    el.attribs["href"] = newVal;
  }

  /**
   * Sanitize relative links to be absolute.
   */
  sanitizeRelativeLink(el: any, attrName: string, base: string) {
    const val = el.attribs[attrName];

    if (val) {
      const valUrl = url.parse(val);

      if (this._isRelativeLink(val)) {
        const newVal = urljoin(base, val);
        el.attribs[attrName] = newVal.toLowerCase();
      }
    }
  }

  /**
   * Determine if a link is to github.com
   */
  _isGithubLink(href: string) {
    const hrefUrl = url.parse(href);
    return (
      hrefUrl.hostname && hrefUrl.pathname && href.indexOf("github.com") >= 0
    );
  }

  /**
   * Determine if a link is relative.
   */
  _isRelativeLink(href: string) {
    const hrefUrl = url.parse(href);

    // Relative link has a pathname but not a host
    return !hrefUrl.host && hrefUrl.pathname;
  }

  /**
   * Determine if a project is listed on firebaseopensource.com
   */
  _isIncludedProject(org: string, repo: string) {
    if (org === "firebase") {
      return true;
    }

    if (ADDITIONAL_PROJECTS.indexOf(`${org}::${repo}`) >= 0) {
      return true;
    }

    return false;
  }

  /**
   * Sanitize the content Html.
   */
  sanitizeHtml(
    repoId: string,
    page: string,
    config: ProjectConfig,
    html: string
  ) {
    // Links
    // * Links to page content files should go to our page
    // * Links to source files should go to github
    //
    // Images
    // * Images and other things should be made into githubusercontent links
    // * Remove badges

    let pageDir = "";
    if (page) {
      const lastSlash = page.lastIndexOf("/");
      pageDir = page.substring(0, lastSlash);
      if (lastSlash >= 0) {
        pageDir = page.substring(0, lastSlash);
      }
    }

    const renderedBaseUrl = urljoin(
      this.getRenderedContentBaseUrl(repoId),
      pageDir
    );
    const rawBaseUrl = urljoin(this.getRawContentBaseUrl(repoId), pageDir);

    const $ = cheerio.load(html);
    const sections = [];

    // Resolve all relative links to github
    const that = this;
    $("a").each((_: any, el: any) => {
      const href = el.attribs["href"];
      if (!href) {
        return;
      }

      if (that._isGithubLink(href)) {
        // Convert github.com/org/foo links to firebaseopensource links
        const hrefUrl = url.parse(href);

        const pathSegments = hrefUrl.pathname
          .split("/")
          .filter((seg: string) => seg.trim().length > 0);

        if (pathSegments.length == 2) {
          const org = pathSegments[0];
          const repo = pathSegments[1];

          if (!that._isIncludedProject(org, repo)) {
            return;
          }

          const newLink = "/projects/" + pathSegments.join("/") + "/";

          log.debug(repoId, `Replacing ${href} with ${newLink}.`);
          el.attribs["href"] = newLink.toLowerCase();
        }
      }

      if (that._isRelativeLink(href)) {
        // Check if the link is to a page within the repo
        const repoRelative = path.join(pageDir, href);
        if (config.pages && config.pages[repoRelative]) {
          log.debug(repoId, `Lowercasing relative link ${repoRelative}.`);
          that.lowercaseLink(el);
        } else {
          that.sanitizeRelativeLink(el, "href", renderedBaseUrl);
        }
      }
    });

    // Resolve all relative images, add class to parent
    $("img").each((_: any, el: any) => {
      const src = el.attribs["src"];
      if (!src) {
        return;
      }

      const badgeKeywords = [
        "travis-ci.org",
        "shields.io",
        "coveralls.io",
        "badge.fury.io",
        "gitter.im",
        "circleci.com",
        "opencollective.com",
        "cirrus-ci.com"
      ];

      let isBadge = false;
      badgeKeywords.forEach(word => {
        if (src.indexOf(word) >= 0) {
          isBadge = true;
        }
      });

      if (isBadge) {
        // Mark Badges
        $(el).addClass("img-badge");
      } else {
        // Add the image-parent class to the parent
        $(el)
          .parent()
          .addClass("img-parent");
      }

      that.sanitizeRelativeLink(el, "src", rawBaseUrl);
    });

    return $.html();
  }

  /**
   * Turn HTML into a sections objects.
   */
  htmlToSections(html: string): PageContent {
    const $ = cheerio.load(html);
    const sections: PageSection[] = [];

    let $headerChildren = $("div", "<div></div>");

    let $h1 = $("h1").first();
    $h1.nextUntil("h2").each((_: any, el: any) => {
      $headerChildren = $headerChildren.append(el);
    });

    const header: PageSection = {
      name: $h1.text(),
      content: $headerChildren.html()
    };

    $("h2").each((_: any, el: any) => {
      let $sibchils = $("div", "<div></div>");

      $(el)
        .nextUntil("h2")
        .each((_: any, el: any) => {
          $sibchils = $sibchils.append(el);
        });

      sections.push({
        name: $(el).text(),
        content: $sibchils.html()
      });
    });

    return {
      header,
      sections
    };
  }

  /**
   * Takes an object and returns a new object with all array properties converted to
   * maps to booleans.
   *
   * Assumes no nested arrays.
   */
  arraysToMaps(obj: any) {
    const newobj: any = {};

    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (obj[key] && obj[key].constructor === Array) {
          const arr = obj[key];
          const map: any = {};

          arr.forEach((item: string) => {
            const itemKey = item.toLowerCase();
            map[itemKey] = true;
          });

          newobj[key] = map;
        } else {
          newobj[key] = obj[key];
        }
      }
    }

    return newobj;
  }

  /**
   * Parse a project ID slug into {owner,repo,path}.
   */
  parseProjectId(id: string) {
    const sections = id.split("::");

    if (sections.length < 2) {
      throw `Invalid project id: ${id}`;
    }

    const owner = sections[0];
    const repo = sections[1];

    let path = undefined;
    if (sections.length > 2) {
      const pathSections = sections.slice(2, sections.length);
      path = pathSections.join("/");
    }

    return {
      owner,
      repo,
      path
    };
  }
}
