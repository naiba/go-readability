/*
 * Copyright (c) 2018, 奶爸<1@5.nu>
 * All rights reserved.
 */

/*eslint-env es6:false*/

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

/**
 * 共有构造方法
 * 这里面对成员变量和配置参数进行了一些初始化操作。
 * @param {HTMLDocument} doc     要解析的 document
 * @param {Object}       options 解析配置
 */
function Readability(doc, options) {

    // In some older versions, people passed a URI as the first argument. Cope:
    if (options && options.documentElement) {
        doc = options;
        options = arguments[2];
    } else if (!doc || !doc.documentElement) {
        throw new Error("First argument to Readability constructor should be a document object.");
    }

    options = options || {};

    this._doc = doc;
    this._articleTitle = null;
    this._articleByline = null;
    this._articleDir = null;
    this._attempts = [];

    // Configurable options
    this._debug = !!options.debug;
    // 文档最多包含 element 数
    this._maxElemsToParse = options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
    this._nbTopCandidates = options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
    this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
    this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(options.classesToPreserve || []);

    // Start with all flags set
    this._flags = this.FLAG_STRIP_UNLIKELYS |
        this.FLAG_WEIGHT_CLASSES |
        this.FLAG_CLEAN_CONDITIONALLY;

    var logEl;

    // Control whether log messages are sent to the console
    if (this._debug) {
        logEl = function (e) {
            var rv = e.nodeName + " ";
            if (e.nodeType == e.TEXT_NODE) {
                return rv + '("' + e.textContent + '")';
            }
            var classDesc = e.className && ("." + e.className.replace(/ /g, "."));
            var elDesc = "";
            if (e.id)
                elDesc = "(#" + e.id + classDesc + ")";
            else if (classDesc)
                elDesc = "(" + classDesc + ")";
            return rv + elDesc;
        };
        this.log = function () {
            if (typeof dump !== "undefined") {
                var msg = Array.prototype.map.call(arguments, function (x) {
                    return (x && x.nodeName) ? logEl(x) : x;
                }).join(" ");
                dump("Reader: (Readability) " + msg + "\n");
            } else if (typeof console !== "undefined") {
                var args = ["Reader: (Readability) "].concat(arguments);
                console.log.apply(console, args);
            }
        };
    } else {
        this.log = function () {
        };
    }
}

Readability.prototype = {
    FLAG_STRIP_UNLIKELYS: 0x1,
    FLAG_WEIGHT_CLASSES: 0x2,
    FLAG_CLEAN_CONDITIONALLY: 0x4,

    // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,

    // Max number of nodes supported by this parser. Default: 0 (no limit)
    DEFAULT_MAX_ELEMS_TO_PARSE: 0,

    // The number of top candidates to consider when analysing how
    // tight the competition is among candidates.
    DEFAULT_N_TOP_CANDIDATES: 5,

    // Element tags to score by default.
    DEFAULT_TAGS_TO_SCORE: "section,h2,h3,h4,h5,h6,p,td,pre".toUpperCase().split(","),

    // The default number of chars an article must have in order to return a result
    DEFAULT_CHAR_THRESHOLD: 500,

    // All of the regular expressions in use within readability.
    // Defined up here so we don't instantiate them repeatedly in loops.
    REGEXPS: {
        unlikelyCandidates: /banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|foot|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
        okMaybeItsACandidate: /and|article|body|column|main|shadow|app|container/i,
        positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
        negative: /hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i,
        extraneous: /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
        byline: /byline|author|dateline|writtenby|p-author/i,
        replaceFonts: /<(\/?)font[^>]*>/gi,
        normalize: /\s{2,}/g,
        videos: /\/\/(www\.)?(dailymotion|youtube|youtube-nocookie|player\.vimeo)\.com/i,
        nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
        prevLink: /(prev|earl|old|new|<|«)/i,
        whitespace: /^\s*$/,
        hasContent: /\S$/,
    },

    DIV_TO_P_ELEMS: ["A", "BLOCKQUOTE", "DL", "DIV", "IMG", "OL", "P", "PRE", "TABLE", "UL", "SELECT"],

    ALTER_TO_DIV_EXCEPTIONS: ["DIV", "ARTICLE", "SECTION", "P"],

    PRESENTATIONAL_ATTRIBUTES: ["align", "background", "bgcolor", "border", "cellpadding", "cellspacing", "frame", "hspace", "rules", "style", "valign", "vspace"],

    DEPRECATED_SIZE_ATTRIBUTE_ELEMS: ["TABLE", "TH", "TD", "HR", "PRE"],

    // The commented out elements qualify as phrasing content but tend to be
    // removed by readability when put into paragraphs, so we ignore them here.
    PHRASING_ELEMS: [
        // "CANVAS", "IFRAME", "SVG", "VIDEO",
        "ABBR", "AUDIO", "B", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA",
        "DATALIST", "DFN", "EM", "EMBED", "I", "IMG", "INPUT", "KBD", "LABEL",
        "MARK", "MATH", "METER", "NOSCRIPT", "OBJECT", "OUTPUT", "PROGRESS", "Q",
        "RUBY", "SAMP", "SCRIPT", "SELECT", "SMALL", "SPAN", "STRONG", "SUB",
        "SUP", "TEXTAREA", "TIME", "VAR", "WBR"
    ],

    // These are the classes that readability sets itself.
    CLASSES_TO_PRESERVE: ["page"],

    /**
     * Run any post-process modifications to article content as necessary.
     *
     * 根据需要运行对文章内容的任何后期处理修改。
     *
     * @param Element
     * @return void
     **/
    _postProcessContent: function (articleContent) {
        // Readability cannot open relative uris so we convert them to absolute uris.
        // 可读性无法打开相关uris，因此我们将它们转换为绝对uris。
        this._fixRelativeUris(articleContent);

        // Remove classes.
        // 删除 class
        this._cleanClasses(articleContent);
    },

    /**
     * Iterates over a NodeList, calls `filterFn` for each node and removes node
     * if function returned `true`.
     *
     * If function is not passed, removes all the nodes in node list.
     *
     * @param NodeList nodeList The nodes to operate on
     * @param Function filterFn the function to use as a filter
     * @return void
     */
    _removeNodes: function (nodeList, filterFn) {
        for (var i = nodeList.length - 1; i >= 0; i--) {
            var node = nodeList[i];
            var parentNode = node.parentNode;
            if (parentNode) {
                if (!filterFn || filterFn.call(this, node, i, nodeList)) {
                    parentNode.removeChild(node);
                }
            }
        }
    },

    /**
     * Iterates over a NodeList, and calls _setNodeTag for each node.
     *
     * @param NodeList nodeList The nodes to operate on
     * @param String newTagName the new tag name to use
     * @return void
     */
    _replaceNodeTags: function (nodeList, newTagName) {
        for (var i = nodeList.length - 1; i >= 0; i--) {
            var node = nodeList[i];
            this._setNodeTag(node, newTagName);
        }
    },

    /**
     * Iterate over a NodeList, which doesn't natively fully implement the Array
     * interface.
     *
     * For convenience, the current object context is applied to the provided
     * iterate function.
     *
     * 遍历 node 并执行 fn
     *
     * @param  NodeList nodeList The NodeList.
     * @param  Function fn       The iterate function.
     * @return void
     */
    _forEachNode: function (nodeList, fn) {
        Array.prototype.forEach.call(nodeList, fn, this);
    },

    /**
     * Iterate over a NodeList, return true if any of the provided iterate
     * function calls returns true, false otherwise.
     *
     * For convenience, the current object context is applied to the
     * provided iterate function.
     *
     * 迭代NodeList，如果提供的任何迭代函数调用返回true，则返回true，否则返回false。
     * 为了方便起见，当前的对象上下文被应用于提供的迭代函数。
     *
     * @param  NodeList nodeList The NodeList.
     * @param  Function fn       The iterate function.
     * @return Boolean
     */
    _someNode: function (nodeList, fn) {
        return Array.prototype.some.call(nodeList, fn, this);
    },

    /**
   * Iterate over a NodeList, return true if all of the provided iterate
   * function calls return true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
    _everyNode: function (nodeList, fn) {
        return Array.prototype.every.call(nodeList, fn, this);
    },

    /**
     * Concat all nodelists passed as arguments.
     *
     * @return ...NodeList
     * @return Array
     */
    _concatNodeLists: function () {
        var slice = Array.prototype.slice;
        var args = slice.call(arguments);
        var nodeLists = args.map(function (list) {
            return slice.call(list);
        });
        return Array.prototype.concat.apply([], nodeLists);
    },

    _getAllNodesWithTag: function (node, tagNames) {
        if (node.querySelectorAll) {
            return node.querySelectorAll(tagNames.join(','));
        }
        return [].concat.apply([], tagNames.map(function (tag) {
            var collection = node.getElementsByTagName(tag);
            return Array.isArray(collection) ? collection : Array.from(collection);
        }));
    },

    /**
     * Removes the class="" attribute from every element in the given
     * subtree, except those that match CLASSES_TO_PRESERVE and
     * the classesToPreserve array from the options object.
     *
     * 从给定子树中的每个元素中除去class =“”属性，除了匹配CLASSES_TO_PRESERVE的
     * 元素和来自options对象的classesToPreserve数组。
     *
     * @param Element
     * @return void
     */
    _cleanClasses: function (node) {
        var classesToPreserve = this._classesToPreserve;
        var className = (node.getAttribute("class") || "")
            .split(/\s+/)
            .filter(function (cls) {
                return classesToPreserve.indexOf(cls) != -1;
            })
            .join(" ");

        if (className) {
            node.setAttribute("class", className);
        } else {
            node.removeAttribute("class");
        }

        for (node = node.firstElementChild; node; node = node.nextElementSibling) {
            this._cleanClasses(node);
        }
    },

    /**
     * Converts each <a> and <img> uri in the given element to an absolute URI,
     * ignoring #ref URIs.
     *
     * 将给定元素中的每个<a>和<img> uri转换为绝对URI，忽略#ref URI。
     *
     * @param Element
     * @return void
     */
    _fixRelativeUris: function (articleContent) {
        var baseURI = this._doc.baseURI;
        var documentURI = this._doc.documentURI;

        function toAbsoluteURI(uri) {
            // Leave hash links alone if the base URI matches the document URI:
            if (baseURI == documentURI && uri.charAt(0) == "#") {
                return uri;
            }
            // Otherwise, resolve against base URI:
            try {
                return new URL(uri, baseURI).href;
            } catch (ex) {
                // Something went wrong, just return the original:
            }
            return uri;
        }

        var links = articleContent.getElementsByTagName("a");
        this._forEachNode(links, function (link) {
            var href = link.getAttribute("href");
            if (href) {
                // Replace links with javascript: URIs with text content, since
                // they won't work after scripts have been removed from the page.
                if (href.indexOf("javascript:") === 0) {
                    var text = this._doc.createTextNode(link.textContent);
                    link.parentNode.replaceChild(text, link);
                } else {
                    link.setAttribute("href", toAbsoluteURI(href));
                }
            }
        });

        var imgs = articleContent.getElementsByTagName("img");
        this._forEachNode(imgs, function (img) {
            var src = img.getAttribute("src");
            if (src) {
                img.setAttribute("src", toAbsoluteURI(src));
            }
        });
    },

    /**
     * Get the article title as an H1.
     *
     * @return void
     **/
    _getArticleTitle: function () {
        var doc = this._doc;
        var curTitle = "";
        var origTitle = "";

        try {
            curTitle = origTitle = doc.title;

            // If they had an element with id "title" in their HTML
            if (typeof curTitle !== "string")
                curTitle = origTitle = this._getInnerText(doc.getElementsByTagName('title')[0]);
        } catch (e) {/* ignore exceptions setting the title. */
        }

        var titleHadHierarchicalSeparators = false;

        function wordCount(str) {
            return str.split(/\s+/).length;
        }

        // If there's a separator in the title, first remove the final part
        if ((/ [\|\-\\\/>»] /).test(curTitle)) {
            titleHadHierarchicalSeparators = / [\\\/>»] /.test(curTitle);
            curTitle = origTitle.replace(/(.*)[\|\-\\\/>»] .*/gi, '$1');

            // If the resulting title is too short (3 words or fewer), remove
            // the first part instead:
            if (wordCount(curTitle) < 3)
                curTitle = origTitle.replace(/[^\|\-\\\/>»]*[\|\-\\\/>»](.*)/gi, '$1');
        } else if (curTitle.indexOf(': ') !== -1) {
            // Check if we have an heading containing this exact string, so we
            // could assume it's the full title.
            var headings = this._concatNodeLists(
                doc.getElementsByTagName('h1'),
                doc.getElementsByTagName('h2')
            );
            var trimmedTitle = curTitle.trim();
            var match = this._someNode(headings, function (heading) {
                return heading.textContent.trim() === trimmedTitle;
            });

            // If we don't, let's extract the title out of the original title string.
            if (!match) {
                curTitle = origTitle.substring(origTitle.lastIndexOf(':') + 1);

                // If the title is now too short, try the first colon instead:
                if (wordCount(curTitle) < 3) {
                    curTitle = origTitle.substring(origTitle.indexOf(':') + 1);
                    // But if we have too many words before the colon there's something weird
                    // with the titles and the H tags so let's just use the original title instead
                } else if (wordCount(origTitle.substr(0, origTitle.indexOf(':'))) > 5) {
                    curTitle = origTitle;
                }
            }
        } else if (curTitle.length > 150 || curTitle.length < 15) {
            var hOnes = doc.getElementsByTagName('h1');

            if (hOnes.length === 1)
                curTitle = this._getInnerText(hOnes[0]);
        }

        curTitle = curTitle.trim();
        // If we now have 4 words or fewer as our title, and either no
        // 'hierarchical' separators (\, /, > or ») were found in the original
        // title or we decreased the number of words by more than 1 word, use
        // the original title.
        var curTitleWordCount = wordCount(curTitle);
        if (curTitleWordCount <= 4 &&
            (!titleHadHierarchicalSeparators ||
                curTitleWordCount != wordCount(origTitle.replace(/[\|\-\\\/>»]+/g, "")) - 1)) {
            curTitle = origTitle;
        }

        return curTitle;
    },

    /**
     * 准备HTML文档以提高可读性。 这包括剥离JavaScript，CSS和处理没用的标记等内容。
     *
     * @return void
     **/
    _prepDocument: function () {
        var doc = this._doc;

        // 清理 style 标签
        this._removeNodes(doc.getElementsByTagName("style"));

        // 将多个连续的<br>换成<p>
        if (doc.body) {
            this._replaceBrs(doc.body);
        }

        // 将<font>换成<span>
        this._replaceNodeTags(doc.getElementsByTagName("font"), "SPAN");
    },

    /**
     * Finds the next element, starting from the given node, and ignoring
     * whitespace in between. If the given node is an element, the same node is
     * returned.
     */
    _nextElement: function (node) {
        var next = node;
        while (next
            && (next.nodeType != this.ELEMENT_NODE)
            && this.REGEXPS.whitespace.test(next.textContent)) {
            next = next.nextSibling;
        }
        return next;
    },

    /**
     * 用一个<p>替换多个连续的<br>元素, 忽略<br>元素之间的空白。
     * 例如：
     *      <div> foo <br> bar <br> <br> abc<br> </div>
     * 会变成：
     *      <div> foo <br>bar<p>abc</p></div>
     */
    _replaceBrs: function (elem) {
        this._forEachNode(this._getAllNodesWithTag(elem, ["br"]), function (br) {
            var next = br.nextSibling;

            // Whether 2 or more <br> elements have been found and replaced with a
            // <p> block.
            // 当有 2 个或多个 <br> 时替换成 <p>
            var replaced = false;

            // If we find a <br> chain, remove the <br>s until we hit another element
            // or non-whitespace. This leaves behind the first <br> in the chain
            // (which will be replaced with a <p> later).
            // 如果找到了一串相连的 <br>，忽略中间的空格，移除所有相连的 <br>
            while ((next = this._nextElement(next)) && (next.tagName == "BR")) {
                replaced = true;
                var brSibling = next.nextSibling;
                next.parentNode.removeChild(next);
                next = brSibling;
            }

            // If we removed a <br> chain, replace the remaining <br> with a <p>. Add
            // all sibling nodes as children of the <p> until we hit another <br>
            // chain.
            // 如果移除了 <br> 链，将其余的 <br> 替换为 <p>，将其他相邻节点添加到 <p> 下。直到遇到第二个 <br>
            if (replaced) {
                var p = this._doc.createElement("p");
                br.parentNode.replaceChild(p, br);

                next = p.nextSibling;
                while (next) {
                    // If we've hit another <br><br>, we're done adding children to this <p>.
                    // 如果我们遇到了其他的 <br><br> 结束添加
                    if (next.tagName == "BR") {
                        var nextElem = this._nextElement(next.nextSibling);
                        if (nextElem && nextElem.tagName == "BR")
                            break;
                    }

                    if (!this._isPhrasingContent(next)) break;

                    // Otherwise, make this node a child of the new <p>.
                    // 否则将节点添加为 <p> 的子节点
                    var sibling = next.nextSibling;
                    p.appendChild(next);
                    next = sibling;
                }

                while (p.lastChild && this._isWhitespace(p.lastChild)) p.removeChild(p.lastChild);

                if (p.parentNode.tagName === "P") this._setNodeTag(p.parentNode, "DIV");
            }
        });
    },

    _setNodeTag: function (node, tag) {
        this.log("_setNodeTag", node, tag);
        if (node.__JSDOMParser__) {
            node.localName = tag.toLowerCase();
            node.tagName = tag.toUpperCase();
            return node;
        }

        var replacement = node.ownerDocument.createElement(tag);
        while (node.firstChild) {
            replacement.appendChild(node.firstChild);
        }
        node.parentNode.replaceChild(replacement, node);
        if (node.readability)
            replacement.readability = node.readability;

        for (var i = 0; i < node.attributes.length; i++) {
            replacement.setAttribute(node.attributes[i].name, node.attributes[i].value);
        }
        return replacement;
    },

    /**
     * Prepare the article node for display. Clean out any inline styles,
     * iframes, forms, strip extraneous <p> tags, etc.
     *
     * 准备要显示的文章节点。 清理任何内联样式，iframe，表单，去除无关的<p>标签等。
     *
     * @param Element
     * @return void
     **/
    _prepArticle: function (articleContent) {
        this._cleanStyles(articleContent);

        // Check for data tables before we continue, to avoid removing items in
        // those tables, which will often be isolated even though they're
        // visually linked to other content-ful elements (text, images, etc.).
        // 在我们继续之前检查数据表，以避免移除这些表中的项目，即使它们与其他内容元素（文本，图像等）
        // 可视化链接，这些表格也会被隔离。
        this._markDataTables(articleContent);

        // Clean out junk from the article content
        // 清除文章内容中的垃圾
        this._cleanConditionally(articleContent, "form");
        this._cleanConditionally(articleContent, "fieldset");
        this._clean(articleContent, "object");
        this._clean(articleContent, "embed");
        this._clean(articleContent, "h1");
        this._clean(articleContent, "footer");
        this._clean(articleContent, "link");
        this._clean(articleContent, "aside");

        // Clean out elements have "share" in their id/class combinations from final top candidates,
        // which means we don't remove the top candidates even they have "share".
        // 清理出来的元素在最终候选名单中与他们的id / class组合“share”，这意味着即使他们有“share”
        // ，我们也不会删除顶级候选人。
        this._forEachNode(articleContent.children, function (topCandidate) {
            this._cleanMatchedNodes(topCandidate, /share/);
        });

        // If there is only one h2 and its text content substantially equals article title,
        // they are probably using it as a header and not a subheader,
        // so remove it since we already extract the title separately.
        // 如果只有一个h2，并且其文本内容与文章标题大致相同，那么它们可能将其用作标题而不是子标题，因此，
        // 请将其删除，因为我们已经分别提取标题。
        var h2 = articleContent.getElementsByTagName('h2');
        if (h2.length === 1) {
            var lengthSimilarRate = (h2[0].textContent.length - this._articleTitle.length) / this._articleTitle.length;
            if (Math.abs(lengthSimilarRate) < 0.5) {
                var titlesMatch = false;
                if (lengthSimilarRate > 0) {
                    titlesMatch = h2[0].textContent.includes(this._articleTitle);
                } else {
                    titlesMatch = this._articleTitle.includes(h2[0].textContent);
                }
                if (titlesMatch) {
                    this._clean(articleContent, "h2");
                }
            }
        }

        this._clean(articleContent, "iframe");
        this._clean(articleContent, "input");
        this._clean(articleContent, "textarea");
        this._clean(articleContent, "select");
        this._clean(articleContent, "button");
        this._cleanHeaders(articleContent);

        // Do these last as the previous stuff may have removed junk
        // that will affect these
        // 这些最后的东西可能会删除会影响这些东西的垃圾
        this._cleanConditionally(articleContent, "table");
        this._cleanConditionally(articleContent, "ul");
        this._cleanConditionally(articleContent, "div");

        // Remove extra paragraphs
        // 删除多余的段落
        this._removeNodes(articleContent.getElementsByTagName('p'), function (paragraph) {
            var imgCount = paragraph.getElementsByTagName('img').length;
            var embedCount = paragraph.getElementsByTagName('embed').length;
            var objectCount = paragraph.getElementsByTagName('object').length;
            // At this point, nasty iframes have been removed, only remain embedded video ones.
            // 此时，讨厌的iframe已被删除，只保留嵌入的视频。
            var iframeCount = paragraph.getElementsByTagName('iframe').length;
            var totalCount = imgCount + embedCount + objectCount + iframeCount;

            return totalCount === 0 && !this._getInnerText(paragraph, false);
        });

        this._forEachNode(this._getAllNodesWithTag(articleContent, ["br"]), function (br) {
            var next = this._nextElement(br.nextSibling);
            if (next && next.tagName == "P")
                br.parentNode.removeChild(br);
        });

        // Remove single-cell tables
        // 移除单单元格表格
        this._forEachNode(this._getAllNodesWithTag(articleContent, ["table"]), function (table) {
            var tbody = this._hasSingleTagInsideElement(table, "TBODY") ? table.firstElementChild : table;
            if (this._hasSingleTagInsideElement(tbody, "TR")) {
                var row = tbody.firstElementChild;
                if (this._hasSingleTagInsideElement(row, "TD")) {
                    var cell = row.firstElementChild;
                    cell = this._setNodeTag(cell, this._everyNode(cell.childNodes, this._isPhrasingContent) ? "P" : "DIV");
                    table.parentNode.replaceChild(cell, table);
                }
            }
        });
    },

    /**
     * Initialize a node with the readability object. Also checks the
     * className/id for special names to add to its score.
     *
     * 用可读性对象初始化一个节点。 还要检查className / id以获取特殊名称以添加到其分数中。
     *
     * @param Element
     * @return void
     **/
    _initializeNode: function (node) {
        node.readability = { "contentScore": 0 };

        switch (node.tagName) {
            case 'DIV':
                node.readability.contentScore += 5;
                break;

            case 'PRE':
            case 'TD':
            case 'BLOCKQUOTE':
                node.readability.contentScore += 3;
                break;

            case 'ADDRESS':
            case 'OL':
            case 'UL':
            case 'DL':
            case 'DD':
            case 'DT':
            case 'LI':
            case 'FORM':
                node.readability.contentScore -= 3;
                break;

            case 'H1':
            case 'H2':
            case 'H3':
            case 'H4':
            case 'H5':
            case 'H6':
            case 'TH':
                node.readability.contentScore -= 5;
                break;
        }

        node.readability.contentScore += this._getClassWeight(node);
    },

    _removeAndGetNext: function (node) {
        var nextNode = this._getNextNode(node, true);
        node.parentNode.removeChild(node);
        return nextNode;
    },

    /**
     * 从 node 开始遍历DOM，
     * 如果 ignoreSelfAndKids 为 true 则不遍历子 element
     * 改为遍历 兄弟 和 父级兄弟 element
     */
    _getNextNode: function (node, ignoreSelfAndKids) {
        // 如果 ignoreSelfAndKids 不为 true 且 node 有子 element 返回第一个子 element
        if (!ignoreSelfAndKids && node.firstElementChild) {
            return node.firstElementChild;
        }
        // 然后是兄弟 element
        if (node.nextElementSibling) {
            return node.nextElementSibling;
        }
        // 最后，父节点的兄弟 element
        //（因为这是深度优先遍历，我们已经遍历了父节点本身）。
        do {
            node = node.parentNode;
        } while (node && !node.nextElementSibling);
        return node && node.nextElementSibling;
    },

    _checkByline: function (node, matchString) {
        if (this._articleByline) {
            return false;
        }

        if (node.getAttribute !== undefined) {
            var rel = node.getAttribute("rel");
        }

        if ((rel === "author" || this.REGEXPS.byline.test(matchString)) && this._isValidByline(node.textContent)) {
            this._articleByline = node.textContent.trim();
            return true;
        }

        return false;
    },

    _getNodeAncestors: function (node, maxDepth) {
        maxDepth = maxDepth || 0;
        var i = 0, ancestors = [];
        while (node.parentNode) {
            ancestors.push(node.parentNode);
            if (maxDepth && ++i === maxDepth)
                break;
            node = node.parentNode;
        }
        return ancestors;
    },

    /***
     * grabArticle - 使用各种指标（内容分数，类名称，元素类型），查找最有可能成为用户想要阅读的内容的内容。
     * 然后返回它包装在一个div。
     *
     * @param page 一个完整的html页面，包含body
     * @return Element
     **/
    _grabArticle: function (page) {
        this.log("**** grabArticle ****");
        var doc = this._doc;
        var isPaging = (page !== null ? true : false);
        page = page ? page : this._doc.body;

        // 没有body，无法抓取文章！
        if (!page) {
            this.log("No body found in document. Abort.");
            return null;
        }

        var pageCacheHtml = page.innerHTML;

        while (true) {
            var stripUnlikelyCandidates = this._flagIsActive(this.FLAG_STRIP_UNLIKELYS);

            // First, node prepping. Trash nodes that look cruddy (like ones with the
            // class name "comment", etc), and turn divs into P tags where they have been
            // used inappropriately (as in, where they contain no other block level elements.)
            // 首先，节点预处理。 清理看起来很糟糕的垃圾节点（比如类名为“comment”的垃圾节点），
            // 并将div转换为P标签，清理空节点。
            var elementsToScore = [];
            var node = this._doc.documentElement;

            while (node) {
                // 元素类名和ID
                var matchString = node.className + " " + node.id;

                if (!this._isProbablyVisible(node)) {
                    this.log("Removing hidden node - " + matchString);
                    node = this._removeAndGetNext(node);
                    continue;
                }

                // Check to see if this node is a byline, and remove it if it is.
                // 如果是作者信息 node，删除并将指针移到下一个 node
                if (this._checkByline(node, matchString)) {
                    this.log("checkByline", node, matchString)
                    node = this._removeAndGetNext(node);
                    continue;
                }

                // Remove unlikely candidates
                // 清理垃圾标签
                if (stripUnlikelyCandidates && matchString.trim().length > 0) {
                    if (this.REGEXPS.unlikelyCandidates.test(matchString) &&
                        !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
                        node.tagName !== "BODY" &&
                        node.tagName !== "A") {
                        this.log("Removing unlikely candidate - " + matchString);
                        node = this._removeAndGetNext(node);
                        continue;
                    }
                }

                // Remove DIV, SECTION, and HEADER nodes without any content(e.g. text, image, video, or iframe).
                // 清理不含任何内容的 DIV, SECTION, 和 HEADER
                if ((node.tagName === "DIV" || node.tagName === "SECTION" || node.tagName === "HEADER" ||
                    node.tagName === "H1" || node.tagName === "H2" || node.tagName === "H3" ||
                    node.tagName === "H4" || node.tagName === "H5" || node.tagName === "H6") &&
                    this._isElementWithoutContent(node)) {
                    node = this._removeAndGetNext(node);
                    continue;
                }

                // 内容标签，加分项
                if (this.DEFAULT_TAGS_TO_SCORE.indexOf(node.tagName) !== -1) {
                    elementsToScore.push(node);
                }

                // Turn all divs that don't have children block level elements into p's
                // 将所有没有 children 的 div 转换为 p
                if (node.tagName === "DIV") {

                    // Put phrasing content into paragraphs.
                    // 将短语内容分段。
                    var p = null;
                    var childNode = node.firstChild;
                    while (childNode) {
                        var nextSibling = childNode.nextSibling;
                        if (this._isPhrasingContent(childNode)) {
                            if (p !== null) {
                                p.appendChild(childNode);
                            } else if (!this._isWhitespace(childNode)) {
                                p = doc.createElement('p');
                                node.replaceChild(p, childNode);
                                p.appendChild(childNode);
                            }
                        } else if (p !== null) {
                            while (p.lastChild && this._isWhitespace(p.lastChild)) p.removeChild(p.lastChild);
                            p = null;
                        }
                        childNode = nextSibling;
                    }

                    // Sites like http://mobile.slate.com encloses each paragraph with a DIV
                    // element. DIVs with only a P element inside and no text content can be
                    // safely converted into plain P elements to avoid confusing the scoring
                    // algorithm with DIVs with are, in practice, paragraphs.

                    // 将只包含一个 p 标签的 div 标签去掉，将 p 提出来
                    if (this._hasSinglePInsideElement(node) && this._getLinkDensity(node) < 0.25) {
                        var newNode = node.children[0];
                        node.parentNode.replaceChild(newNode, node);
                        node = newNode;
                        elementsToScore.push(node);
                    }
                    else if (!this._hasChildBlockElement(node)) {
                        // 确定元素含有的都不是块级元素
                        node = this._setNodeTag(node, "P");
                        elementsToScore.push(node);
                    }
                }
                node = this._getNextNode(node);
            }

            /**
             * Loop through all paragraphs, and assign a score to them based on how content-y they look.
             * Then add their score to their parent node.
             *
             * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
             *
             * 循环浏览所有段落，并根据它们的外观如何分配给他们一个分数。
             * 然后将他们的分数添加到他们的父节点。
             * 分数由 commas，class 名称 等的 数目决定。也许最终链接密度。
             **/
            var candidates = [];
            this._forEachNode(elementsToScore, function (elementToScore) {
                if (!elementToScore.parentNode || typeof (elementToScore.parentNode.tagName) === 'undefined')
                    return;

                // If this paragraph is less than 25 characters, don't even count it.
                // 如果该段落少于25个字符，则不计算它。
                var innerText = this._getInnerText(elementToScore);
                if (innerText.length < 25)
                    return;

                // 排除没有祖先的节点。
                var ancestors = this._getNodeAncestors(elementToScore, 3);
                if (ancestors.length === 0)
                    return;

                var contentScore = 0;

                // Add a point for the paragraph itself as a base.
                // 为段落本身添加一个基础分
                contentScore += 1;

                // Add points for any commas within this paragraph.
                // 在此段落内为所有逗号添加分数。
                contentScore += innerText.split(',').length;

                // For every 100 characters in this paragraph, add another point. Up to 3 points.
                // 本段中每100个字符添加一分。 最多3分。
                contentScore += Math.min(Math.floor(innerText.length / 100), 3);

                // Initialize and score ancestors.
                // 给祖先初始化并评分。
                this._forEachNode(ancestors, function (ancestor, level) {
                    if (!ancestor.tagName || !ancestor.parentNode || typeof (ancestor.parentNode.tagName) === 'undefined')
                        return;

                    if (typeof (ancestor.readability) === 'undefined') {
                        this._initializeNode(ancestor);
                        candidates.push(ancestor);
                    }

                    // Node score divider:
                    // - parent:             1 (no division)
                    // - grandparent:        2
                    // - great grandparent+: ancestor level * 3
                    // 节点加分规则：
                    // - 父母：1（不划分）
                    // - 祖父母：2
                    // - 祖父母：祖先等级* 3
                    if (level === 0)
                        var scoreDivider = 1;
                    else if (level === 1)
                        scoreDivider = 2;
                    else
                        scoreDivider = level * 3;
                    ancestor.readability.contentScore += contentScore / scoreDivider;
                });
            });

            // After we've calculated scores, loop through all of the possible
            // candidate nodes we found and find the one with the highest score.
            // 在我们计算出分数后，循环遍历我们找到的所有可能的候选节点，并找到分数最高的候选节点。
            var topCandidates = [];
            for (var c = 0, cl = candidates.length; c < cl; c += 1) {
                var candidate = candidates[c];

                // Scale the final candidates score based on link density. Good content
                // should have a relatively small link density (5% or less) and be mostly
                // unaffected by this operation.
                // 根据链接密度缩放最终候选人分数。 良好的内容应该有一个相对较小的链接密度（5％或更少），并且大多不受此操作的影响。
                var candidateScore = candidate.readability.contentScore * (1 - this._getLinkDensity(candidate));
                candidate.readability.contentScore = candidateScore;

                this.log('Candidate:', candidate, "with score " + candidateScore);

                for (var t = 0; t < this._nbTopCandidates; t++) {
                    var aTopCandidate = topCandidates[t];

                    if (!aTopCandidate || candidateScore > aTopCandidate.readability.contentScore) {
                        topCandidates.splice(t, 0, candidate);
                        if (topCandidates.length > this._nbTopCandidates)
                            topCandidates.pop();
                        break;
                    }
                }
            }

            var topCandidate = topCandidates[0] || null;
            var neededToCreateTopCandidate = false;
            var parentOfTopCandidate;

            // If we still have no top candidate, just use the body as a last resort.
            // We also have to copy the body node so it is something we can modify.
            // 如果我们还没有topCandidate，那就把 body 作为 topCandidate。
            // 我们还必须复制body节点，以便我们可以修改它。
            if (topCandidate === null || topCandidate.tagName === "BODY") {
                // Move all of the page's children into topCandidate
                // 将所有页面的子项移到topCandidate中
                topCandidate = doc.createElement("DIV");
                neededToCreateTopCandidate = true;
                // Move everything (not just elements, also text nodes etc.) into the container
                // so we even include text directly in the body:
                // 将所有内容（不仅仅是元素，也包括文本节点等）移动到容器中，因此我们甚至直接在文本中包含文本：
                var kids = page.childNodes;
                while (kids.length) {
                    this.log("Moving child out:", kids[0]);
                    topCandidate.appendChild(kids[0]);
                }
                page.appendChild(topCandidate);

                this._initializeNode(topCandidate);
            } else if (topCandidate) {
                // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
                // and whose scores are quite closed with current `topCandidate` node.
                // 如果它包含（至少三个）属于topCandidates数组并且其分数与
                // 当前topCandidate节点非常接近的节点，则找到一个更好的顶级候选节点。
                var alternativeCandidateAncestors = [];
                for (var i = 1; i < topCandidates.length; i++) {
                    if (topCandidates[i].readability.contentScore / topCandidate.readability.contentScore >= 0.75) {
                        alternativeCandidateAncestors.push(this._getNodeAncestors(topCandidates[i]));
                    }
                }
                var MINIMUM_TOPCANDIDATES = 3;
                if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
                    parentOfTopCandidate = topCandidate.parentNode;
                    while (parentOfTopCandidate.tagName !== "BODY") {
                        var listsContainingThisAncestor = 0;
                        for (var ancestorIndex = 0; ancestorIndex < alternativeCandidateAncestors.length && listsContainingThisAncestor < MINIMUM_TOPCANDIDATES; ancestorIndex++) {
                            listsContainingThisAncestor += Number(alternativeCandidateAncestors[ancestorIndex].includes(parentOfTopCandidate));
                        }
                        if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
                            topCandidate = parentOfTopCandidate;
                            break;
                        }
                        parentOfTopCandidate = parentOfTopCandidate.parentNode;
                    }
                }
                if (!topCandidate.readability) {
                    this._initializeNode(topCandidate);
                }

                // Because of our bonus system, parents of candidates might have scores
                // themselves. They get half of the node. There won't be nodes with higher
                // scores than our topCandidate, but if we see the score going *up* in the first
                // few steps up the tree, that's a decent sign that there might be more content
                // lurking in other places that we want to unify in. The sibling stuff
                // below does some of that - but only if we've looked high enough up the DOM
                // tree.
                // 由于我们的奖金制度，节点的父节点可能会有自己的分数。 他们得到节点的一半。 不会有比我们的
                // topCandidate分数更高的节点，但是如果我们在树的前几个步骤中看到分数增加，这是一个体面
                // 的信号，可能会有更多的内容潜伏在我们想要的其他地方 统一英寸下面的兄弟姐妹的东西做了一些
                // - 但只有当我们已经足够高的DOM树。
                parentOfTopCandidate = topCandidate.parentNode;
                var lastScore = topCandidate.readability.contentScore;
                // The scores shouldn't get too low.
                // 分数不能太低。
                var scoreThreshold = lastScore / 3;
                while (parentOfTopCandidate.tagName !== "BODY") {
                    if (!parentOfTopCandidate.readability) {
                        parentOfTopCandidate = parentOfTopCandidate.parentNode;
                        continue;
                    }
                    var parentScore = parentOfTopCandidate.readability.contentScore;
                    if (parentScore < scoreThreshold)
                        break;
                    if (parentScore > lastScore) {
                        // Alright! We found a better parent to use.
                        // 找到了一个更好的节点
                        topCandidate = parentOfTopCandidate;
                        break;
                    }
                    lastScore = parentOfTopCandidate.readability.contentScore;
                    parentOfTopCandidate = parentOfTopCandidate.parentNode;
                }

                // If the top candidate is the only child, use parent instead. This will help sibling
                // joining logic when adjacent content is actually located in parent's sibling node.
                // 如果最上面的候选人是唯一的孩子，那就用父母代替。 当相邻内容实际位于父节点的兄弟节点中时，这将有助于兄弟连接逻辑。
                parentOfTopCandidate = topCandidate.parentNode;
                while (parentOfTopCandidate.tagName != "BODY" && parentOfTopCandidate.children.length == 1) {
                    topCandidate = parentOfTopCandidate;
                    parentOfTopCandidate = topCandidate.parentNode;
                }
                if (!topCandidate.readability) {
                    this._initializeNode(topCandidate);
                }
            }

            // Now that we have the top candidate, look through its siblings for content
            // that might also be related. Things like preambles, content split by ads
            // that we removed, etc.
            // 现在我们有了最好的候选人，通过它的兄弟姐妹查看可能也有关联的内容。 诸如前导，内容被我们删除的广告分割等
            var articleContent = doc.createElement("DIV");
            if (isPaging) {
                articleContent.id = "readability-content";
            }

            var siblingScoreThreshold = Math.max(10, topCandidate.readability.contentScore * 0.2);
            // Keep potential top candidate's parent node to try to get text direction of it later.
            // 让潜在的顶级候选人的父节点稍后尝试获取文本方向。
            parentOfTopCandidate = topCandidate.parentNode;
            var siblings = parentOfTopCandidate.children;

            for (var s = 0, sl = siblings.length; s < sl; s++) {
                var sibling = siblings[s];
                var append = false;

                this.log("Looking at sibling node:", sibling, sibling.readability ? ("with score " + sibling.readability.contentScore) : '');
                this.log("Sibling has score", sibling.readability ? sibling.readability.contentScore : 'Unknown');

                if (sibling === topCandidate) {
                    append = true;
                } else {
                    var contentBonus = 0;

                    // Give a bonus if sibling nodes and top candidates have the example same classname
                    // 如果兄弟节点和顶级候选人具有相同的类名示例，则给予奖励
                    if (sibling.className === topCandidate.className && topCandidate.className !== "")
                        contentBonus += topCandidate.readability.contentScore * 0.2;

                    if (sibling.readability &&
                        ((sibling.readability.contentScore + contentBonus) >= siblingScoreThreshold)) {
                        append = true;
                    } else if (sibling.nodeName === "P") {
                        var linkDensity = this._getLinkDensity(sibling);
                        var nodeContent = this._getInnerText(sibling);
                        var nodeLength = nodeContent.length;

                        if (nodeLength > 80 && linkDensity < 0.25) {
                            append = true;
                        } else if (nodeLength < 80 && nodeLength > 0 && linkDensity === 0 &&
                            nodeContent.search(/\.( |$)/) !== -1) {
                            append = true;
                        }
                    }
                }

                if (append) {
                    this.log("Appending node:", sibling);

                    if (this.ALTER_TO_DIV_EXCEPTIONS.indexOf(sibling.nodeName) === -1) {
                        // We have a node that isn't a common block level element, like a form or td tag.
                        // Turn it into a div so it doesn't get filtered out later by accident.
                        this.log("Altering sibling:", sibling, 'to div.');

                        sibling = this._setNodeTag(sibling, "DIV");
                    }

                    articleContent.appendChild(sibling);
                    // siblings is a reference to the children array, and
                    // sibling is removed from the array when we call appendChild().
                    // As a result, we must revisit this index since the nodes
                    // have been shifted.
                    s -= 1;
                    sl -= 1;
                }
            }

            if (this._debug)
                this.log("Article content pre-prep: " + articleContent.innerHTML);
            // So we have all of the content that we need. Now we clean it up for presentation.
            // 所以我们拥有我们需要的所有内容。 现在我们清理它以供演示。
            this._prepArticle(articleContent);
            if (this._debug)
                this.log("Article content post-prep: " + articleContent.innerHTML);

            if (neededToCreateTopCandidate) {
                // We already created a fake div thing, and there wouldn't have been any siblings left
                // for the previous loop, so there's no point trying to create a new div, and then
                // move all the children over. Just assign IDs and class names here. No need to append
                // because that already happened anyway.
                // 我们已经创建了一个假的div事物，并且之前的循环没有任何兄弟姐妹，所以尝试创建一个新的div，然后将所有的
                // 孩子移动过去都没有意义。 只需在这里分配ID和类名。 无需追加，因为无论如何已经发生了。
                topCandidate.id = "readability-page-1";
                topCandidate.className = "page";
            } else {
                var div = doc.createElement("DIV");
                div.id = "readability-page-1";
                div.className = "page";
                var children = articleContent.childNodes;
                while (children.length) {
                    div.appendChild(children[0]);
                }
                articleContent.appendChild(div);
            }

            if (this._debug)
                this.log("Article content after paging: " + articleContent.innerHTML);

            var parseSuccessful = true;

            // Now that we've gone through the full algorithm, check to see if
            // we got any meaningful content. If we didn't, we may need to re-run
            // grabArticle with different flags set. This gives us a higher likelihood of
            // finding the content, and the sieve approach gives us a higher likelihood of
            // finding the -right- content.
            // 现在我们已经完成了完整的算法，请检查是否有任何有意义的内容。 如果我们没有，我们可能需要
            // 重新运行具有不同标志的grabArticle。 这使我们更有可能找到内容，而筛选方法使我们更有可
            // 能找到正确内容。
            var textLength = this._getInnerText(articleContent, true).length;
            if (textLength < this._charThreshold) {
                parseSuccessful = false;
                page.innerHTML = pageCacheHtml;

                if (this._flagIsActive(this.FLAG_STRIP_UNLIKELYS)) {
                    this._removeFlag(this.FLAG_STRIP_UNLIKELYS);
                    this._attempts.push({ articleContent: articleContent, textLength: textLength });
                } else if (this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
                    this._removeFlag(this.FLAG_WEIGHT_CLASSES);
                    this._attempts.push({ articleContent: articleContent, textLength: textLength });
                } else if (this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
                    this._removeFlag(this.FLAG_CLEAN_CONDITIONALLY);
                    this._attempts.push({ articleContent: articleContent, textLength: textLength });
                } else {
                    this._attempts.push({ articleContent: articleContent, textLength: textLength });
                    // No luck after removing flags, just return the longest text we found during the different loops
                    this._attempts.sort(function (a, b) {
                        return a.textLength < b.textLength;
                    });

                    // But first check if we actually have something
                    if (!this._attempts[0].textLength) {
                        return null;
                    }

                    articleContent = this._attempts[0].articleContent;
                    parseSuccessful = true;
                }
            }

            if (parseSuccessful) {
                // Find out text direction from ancestors of final top candidate.
                // 找出来自最终候选人祖先的文字方向。
                var ancestors = [parentOfTopCandidate, topCandidate].concat(this._getNodeAncestors(parentOfTopCandidate));
                this._someNode(ancestors, function (ancestor) {
                    if (!ancestor.tagName)
                        return false;
                    var articleDir = ancestor.getAttribute("dir");
                    if (articleDir) {
                        this._articleDir = articleDir;
                        return true;
                    }
                    return false;
                });
                return articleContent;
            }
        }
    },

    /**
     * Check whether the input string could be a byline.
     * This verifies that the input is a string, and that the length
     * is less than 100 chars.
     *
     * @param possibleByline {string} - a string to check whether its a byline.
     * @return Boolean - whether the input string is a byline.
     */
    _isValidByline: function (byline) {
        if (typeof byline == 'string' || byline instanceof String) {
            byline = byline.trim();
            return (byline.length > 0) && (byline.length < 100);
        }
        return false;
    },

    /**
     * 尝试从元数据中获取文章的摘要和作者信息。
     *
     * @return Object with optional "excerpt" and "byline" properties
     */
    _getArticleMetadata: function () {
        var metadata = {};
        var values = {};
        var metaElements = this._doc.getElementsByTagName("meta");

        // Match "description", or Twitter's "twitter:description" (Cards)
        // in name attribute.
        var namePattern = /^\s*((twitter)\s*:\s*)?(description|title)\s*$/gi;

        // Match Facebook's Open Graph title & description properties.
        var propertyPattern = /^\s*og\s*:\s*(description|title)\s*$/gi;

        // Find description tags.
        this._forEachNode(metaElements, function (element) {
            var elementName = element.getAttribute("name");
            var elementProperty = element.getAttribute("property");

            if ([elementName, elementProperty].indexOf("author") !== -1) {
                metadata.byline = element.getAttribute("content");
                return;
            }

            var name = null;
            if (namePattern.test(elementName)) {
                name = elementName;
            } else if (propertyPattern.test(elementProperty)) {
                name = elementProperty;
            }

            if (name) {
                var content = element.getAttribute("content");
                if (content) {
                    // Convert to lowercase and remove any whitespace
                    // so we can match below.
                    name = name.toLowerCase().replace(/\s/g, '');
                    values[name] = content.trim();
                }
            }
        });

        if ("description" in values) {
            metadata.excerpt = values["description"];
        } else if ("og:description" in values) {
            // Use facebook open graph description.
            metadata.excerpt = values["og:description"];
        } else if ("twitter:description" in values) {
            // Use twitter cards description.
            metadata.excerpt = values["twitter:description"];
        }

        metadata.title = this._getArticleTitle();
        if (!metadata.title) {
            if ("og:title" in values) {
                // Use facebook open graph title.
                metadata.title = values["og:title"];
            } else if ("twitter:title" in values) {
                // Use twitter cards title.
                metadata.title = values["twitter:title"];
            }
        }

        return metadata;
    },

    /**
     * 清除所有的 script/noscript 节点
     *
     * @param Element
     **/
    _removeScripts: function (doc) {
        this._removeNodes(doc.getElementsByTagName('script'), function (scriptNode) {
            scriptNode.nodeValue = "";
            scriptNode.removeAttribute('src');
            return true;
        });
        this._removeNodes(doc.getElementsByTagName('noscript'));
    },

    /**
     * Check if this node has only whitespace and a single element with given tag
     * Returns false if the DIV node contains non-empty text nodes
     * or if it contains no element with given tag or more than 1 element.
     * 
     * 检查此节点是否只有空白，并且具有给定标记的单个元素如果DIV节点包含非空文本节点，或者它不包含具有给定标记或多个元素的元素，则返回false。
     *
     * @param Element
     * @param string tag of child element
     **/
    _hasSingleTagInsideElement: function(element, tag) {
        // There should be exactly 1 element child with given tag
        // 子节点个数大于一，或者第一个子节点不是本身
        if (element.children.length != 1 || element.children[0].tagName !== tag) {
        return false;
        }

        // And there should be no text nodes with real content
        // 并且不应该有真实内容的文本节点
        return !this._someNode(element.childNodes, function(node) {
        return node.nodeType === this.TEXT_NODE &&
                this.REGEXPS.hasContent.test(node.textContent);
        });
    },

    _isElementWithoutContent: function (node) {
        return node.nodeType === this.ELEMENT_NODE &&
            node.textContent.trim().length == 0 &&
            (node.children.length == 0 ||
                node.children.length == node.getElementsByTagName("br").length + node.getElementsByTagName("hr").length);
    },

    /**
     * 确定元素是否具有任何块级子级元素。
     *
     * @param Element
     */
    _hasChildBlockElement: function (element) {
        return this._someNode(element.childNodes, function (node) {
            return this.DIV_TO_P_ELEMS.indexOf(node.tagName) !== -1 ||
                this._hasChildBlockElement(node);
        });
    },

    /***
     * Determine if a node qualifies as phrasing content.
     * 确定节点是否符合短语内容。
     * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
     **/
    _isPhrasingContent: function (node) {
        return node.nodeType === this.TEXT_NODE || this.PHRASING_ELEMS.indexOf(node.tagName) !== -1 ||
            ((node.tagName === "A" || node.tagName === "DEL" || node.tagName === "INS") &&
                this._everyNode(node.childNodes, this._isPhrasingContent));
    },

    _isWhitespace: function (node) {
        return (node.nodeType === this.TEXT_NODE && node.textContent.trim().length === 0) ||
            (node.nodeType === this.ELEMENT_NODE && node.tagName === "BR");
    },


    /**
     * Get the inner text of a node - cross browser compatibly.
     * This also strips out any excess whitespace to be found.
     *
     * @param Element
     * @param Boolean normalizeSpaces (default: true)
     * @return string
     **/
    _getInnerText: function (e, normalizeSpaces) {
        normalizeSpaces = (typeof normalizeSpaces === 'undefined') ? true : normalizeSpaces;
        var textContent = e.textContent.trim();

        if (normalizeSpaces) {
            return textContent.replace(this.REGEXPS.normalize, " ");
        }
        return textContent;
    },

    /**
     * Get the number of times a string s appears in the node e.
     *
     * @param Element
     * @param string - what to split on. Default is ","
     * @return number (integer)
     **/
    _getCharCount: function (e, s) {
        s = s || ",";
        return this._getInnerText(e).split(s).length - 1;
    },

    /**
     * Remove the style attribute on every e and under.
     * TODO: Test if getElementsByTagName(*) is faster.
     *
     * 删除每个e和下的样式属性。
     *
     * @param Element
     * @return void
     **/
    _cleanStyles: function (e) {
        if (!e || e.tagName.toLowerCase() === 'svg')
            return;

        // Remove `style` and deprecated presentational attributes
        // 删除`style`和不推荐的表示属性
        for (var i = 0; i < this.PRESENTATIONAL_ATTRIBUTES.length; i++) {
            e.removeAttribute(this.PRESENTATIONAL_ATTRIBUTES[i]);
        }

        if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.indexOf(e.tagName) !== -1) {
            e.removeAttribute('width');
            e.removeAttribute('height');
        }

        var cur = e.firstElementChild;
        while (cur !== null) {
            this._cleanStyles(cur);
            cur = cur.nextElementSibling;
        }
    },

    /**
     * Get the density of links as a percentage of the content
     * This is the amount of text that is inside a link divided by the total text in the node.
     *
     * 获取链接密度作为内容的百分比 这是链接内部文本的数量除以节点中的全部文本。
     *
     * @param Element
     * @return number (float)
     **/
    _getLinkDensity: function (element) {
        var textLength = this._getInnerText(element).length;
        if (textLength === 0)
            return 0;

        var linkLength = 0;

        // XXX implement _reduceNodeList?
        this._forEachNode(element.getElementsByTagName("a"), function (linkNode) {
            linkLength += this._getInnerText(linkNode).length;
        });

        return linkLength / textLength;
    },

    /**
     * Get an elements class/id weight. Uses regular expressions to tell if this
     * element looks good or bad.
     *
     * 获取元素类/标识权重。 使用正则表达式来判断这个元素是好还是坏。
     *
     * @param Element
     * @return number (Integer)
     **/
    _getClassWeight: function (e) {
        if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES))
            return 0;

        var weight = 0;

        // Look for a special classname
        // 寻找一个特殊的类名
        if (typeof (e.className) === 'string' && e.className !== '') {
            if (this.REGEXPS.negative.test(e.className))
                weight -= 25;

            if (this.REGEXPS.positive.test(e.className))
                weight += 25;
        }

        // Look for a special ID
        // 寻找一个特殊的ID
        if (typeof (e.id) === 'string' && e.id !== '') {
            if (this.REGEXPS.negative.test(e.id))
                weight -= 25;

            if (this.REGEXPS.positive.test(e.id))
                weight += 25;
        }

        return weight;
    },

    /**
     * Clean a node of all elements of type "tag".
     * (Unless it's a youtube/vimeo video. People love movies.)
     *
     * 清理“tag”类型的所有元素的节点。 （除非它是一个YouTube / VIMEO视频，人们喜欢看电影。）
     *
     * @param Element
     * @param string tag to clean
     * @return void
     **/
    _clean: function (e, tag) {
        var isEmbed = ["object", "embed", "iframe"].indexOf(tag) !== -1;

        this._removeNodes(e.getElementsByTagName(tag), function (element) {
            // Allow youtube and vimeo videos through as people usually want to see those.
            // 允许youtube和vimeo视频通过人们通常希望看到的视频。
            if (isEmbed) {
                var attributeValues = [].map.call(element.attributes, function (attr) {
                    return attr.value;
                }).join("|");

                // First, check the elements attributes to see if any of them contain youtube or vimeo
                // 首先，检查元素属性，看它们是否包含youtube或vimeo
                if (this.REGEXPS.videos.test(attributeValues))
                    return false;

                // Then check the elements inside this element for the same.
                // 然后检查这个元素中的元素是否相同。
                if (this.REGEXPS.videos.test(element.innerHTML))
                    return false;
            }

            return true;
        });
    },

    /**
     * Check if a given node has one of its ancestor tag name matching the
     * provided one.
     *
     * 检查给定节点是否具有与提供的节点相匹配的其祖先标签名称之一。
     *
     * @param  HTMLElement node
     * @param  String      tagName
     * @param  Number      maxDepth
     * @param  Function    filterFn a filter to invoke to determine whether this node 'counts'
     * @return Boolean
     */
    _hasAncestorTag: function (node, tagName, maxDepth, filterFn) {
        maxDepth = maxDepth || 3;
        tagName = tagName.toUpperCase();
        var depth = 0;
        while (node.parentNode) {
            if (maxDepth > 0 && depth > maxDepth)
                return false;
            if (node.parentNode.tagName === tagName && (!filterFn || filterFn(node.parentNode)))
                return true;
            node = node.parentNode;
            depth++;
        }
        return false;
    },

    /**
     * Return an object indicating how many rows and columns this table has.
     *
     * 返回一个对象，指示该表有多少个行和列。
     */
    _getRowAndColumnCount: function (table) {
        var rows = 0;
        var columns = 0;
        var trs = table.getElementsByTagName("tr");
        for (var i = 0; i < trs.length; i++) {
            var rowspan = trs[i].getAttribute("rowspan") || 0;
            if (rowspan) {
                rowspan = parseInt(rowspan, 10);
            }
            rows += (rowspan || 1);

            // Now look for column-related info
            // 现在查找与列相关的信息
            var columnsInThisRow = 0;
            var cells = trs[i].getElementsByTagName("td");
            for (var j = 0; j < cells.length; j++) {
                var colspan = cells[j].getAttribute("colspan") || 0;
                if (colspan) {
                    colspan = parseInt(colspan, 10);
                }
                columnsInThisRow += (colspan || 1);
            }
            columns = Math.max(columns, columnsInThisRow);
        }
        return { rows: rows, columns: columns };
    },

    /**
     * Look for 'data' (as opposed to 'layout') tables, for which we use
     * similar checks as
     * https://dxr.mozilla.org/mozilla-central/rev/71224049c0b52ab190564d3ea0eab089a159a4cf/accessible/html/HTMLTableAccessible.cpp#920
     *
     * 查找'数据'（而不是'布局'）表格，我们使用类似的检查方式，
     * 如https://dxr.mozilla.org/mozilla-central/rev/71224049c0b52ab190564d3ea0eab089a159a4cf/accessible/html/HTMLTableAccessible.cpp#920
     */
    _markDataTables: function (root) {
        var tables = root.getElementsByTagName("table");
        for (var i = 0; i < tables.length; i++) {
            var table = tables[i];
            var role = table.getAttribute("role");
            if (role == "presentation") {
                table._readabilityDataTable = false;
                continue;
            }
            var datatable = table.getAttribute("datatable");
            if (datatable == "0") {
                table._readabilityDataTable = false;
                continue;
            }
            var summary = table.getAttribute("summary");
            if (summary) {
                table._readabilityDataTable = true;
                continue;
            }

            var caption = table.getElementsByTagName("caption")[0];
            if (caption && caption.childNodes.length > 0) {
                table._readabilityDataTable = true;
                continue;
            }

            // If the table has a descendant with any of these tags, consider a data table:
            // 如果表中有任何这些标签的后代，请考虑数据表：
            var dataTableDescendants = ["col", "colgroup", "tfoot", "thead", "th"];
            var descendantExists = function (tag) {
                return !!table.getElementsByTagName(tag)[0];
            };
            if (dataTableDescendants.some(descendantExists)) {
                this.log("Data table because found data-y descendant");
                table._readabilityDataTable = true;
                continue;
            }

            // Nested tables indicate a layout table:
            // 嵌套表格表示布局表格：
            if (table.getElementsByTagName("table")[0]) {
                table._readabilityDataTable = false;
                continue;
            }

            var sizeInfo = this._getRowAndColumnCount(table);
            if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
                table._readabilityDataTable = true;
                continue;
            }
            // Now just go by size entirely:
            // 现在完全按照尺寸进行：
            table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
        }
    },

    /**
     * Clean an element of all tags of type "tag" if they look fishy.
     * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
     *
     * 清洁“标签”类型的所有标签的元素，如果它们看起来很腥。
     * “Fishy”是一种基于内容长度，类名，链接密度，图像和嵌入数量等的算法。
     *
     * @return void
     **/
    _cleanConditionally: function (e, tag) {
        if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY))
            return;

        var isList = tag === "ul" || tag === "ol";

        // Gather counts for other typical elements embedded within.
        // Traverse backwards so we can remove nodes at the same time
        // without effecting the traversal.
        // 聚集计算嵌入其他典型元素。向后返回，以便我们可以在不影响遍历的情况下同时移除节点。
        // TODO: Consider taking into account original contentScore here.
        this._removeNodes(e.getElementsByTagName(tag), function (node) {
            // First check if we're in a data table, in which case don't remove us.
            var isDataTable = function (t) {
                return t._readabilityDataTable;
            };

            if (this._hasAncestorTag(node, "table", -1, isDataTable)) {
                return false;
            }

            var weight = this._getClassWeight(node);
            var contentScore = 0;

            this.log("Cleaning Conditionally", node);

            if (weight + contentScore < 0) {
                return true;
            }

            if (this._getCharCount(node, ',') < 10) {
                // If there are not very many commas, and the number of
                // non-paragraph elements is more than paragraphs or other
                // ominous signs, remove the element.
                // 如果逗号不多，并且非段落元素的数量多于段落或其他不祥的标志，则删除该元素。
                var p = node.getElementsByTagName("p").length;
                var img = node.getElementsByTagName("img").length;
                var li = node.getElementsByTagName("li").length - 100;
                var input = node.getElementsByTagName("input").length;

                var embedCount = 0;
                var embeds = node.getElementsByTagName("embed");
                for (var ei = 0, il = embeds.length; ei < il; ei += 1) {
                    if (!this.REGEXPS.videos.test(embeds[ei].src))
                        embedCount += 1;
                }

                var linkDensity = this._getLinkDensity(node);
                var contentLength = this._getInnerText(node).length;

                var haveToRemove =
                    (img > 1 && p / img < 0.5 && !this._hasAncestorTag(node, "figure")) ||
                    (!isList && li > p) ||
                    (input > Math.floor(p / 3)) ||
                    (!isList && contentLength < 25 && (img === 0 || img > 2) && !this._hasAncestorTag(node, "figure")) ||
                    (!isList && weight < 25 && linkDensity > 0.2) ||
                    (weight >= 25 && linkDensity > 0.5) ||
                    ((embedCount === 1 && contentLength < 75) || embedCount > 1);
                return haveToRemove;
            }
            return false;
        });
    },

    /**
     * Clean out elements whose id/class combinations match specific string.
     *
     * 清除id / class组合与特定字符串匹配的元素。
     *
     * @param Element
     * @param RegExp match id/class combination.
     * @return void
     **/
    _cleanMatchedNodes: function (e, regex) {
        var endOfSearchMarkerNode = this._getNextNode(e, true);
        var next = this._getNextNode(e);
        while (next && next != endOfSearchMarkerNode) {
            if (regex.test(next.className + " " + next.id)) {
                next = this._removeAndGetNext(next);
            } else {
                next = this._getNextNode(next);
            }
        }
    },

    /**
     * Clean out spurious headers from an Element. Checks things like classnames and link density.
     *
     * 清除元素中的虚假标题。 检查类名和链接密度。
     *
     * @param Element
     * @return void
     **/
    _cleanHeaders: function (e) {
        for (var headerIndex = 1; headerIndex < 3; headerIndex += 1) {
            this._removeNodes(e.getElementsByTagName('h' + headerIndex), function (header) {
                return this._getClassWeight(header) < 0;
            });
        }
    },

    // flag 是否启用
    _flagIsActive: function (flag) {
        return (this._flags & flag) > 0;
    },

    _removeFlag: function (flag) {
        this._flags = this._flags & ~flag;
    },

    _isProbablyVisible: function (node) {
        return node.style.display != "none" && !node.hasAttribute("hidden");
    },


    /**
     * Decides whether or not the document is reader-able without parsing the whole thing.
     *
     * @return boolean Whether or not we suspect parse() will suceeed at returning an article object.
     */
    isProbablyReaderable: function (helperIsVisible) {
        var nodes = this._getAllNodesWithTag(this._doc, ["p", "pre"]);

        // Get <div> nodes which have <br> node(s) and append them into the `nodes` variable.
        // Some articles' DOM structures might look like
        // <div>
        //   Sentences<br>
        //   <br>
        //   Sentences<br>
        // </div>
        var brNodes = this._getAllNodesWithTag(this._doc, ["div > br"]);
        if (brNodes.length) {
            var set = new Set();
            [].forEach.call(brNodes, function (node) {
                set.add(node.parentNode);
            });
            nodes = [].concat.apply(Array.from(set), nodes);
        }

        if (!helperIsVisible) {
            helperIsVisible = this._isProbablyVisible;
        }

        var score = 0;
        // This is a little cheeky, we use the accumulator 'score' to decide what to return from
        // this callback:
        return this._someNode(nodes, function (node) {
            if (helperIsVisible && !helperIsVisible(node))
                return false;
            var matchString = node.className + " " + node.id;

            if (this.REGEXPS.unlikelyCandidates.test(matchString) &&
                !this.REGEXPS.okMaybeItsACandidate.test(matchString)) {
                return false;
            }

            if (node.matches && node.matches("li p")) {
                return false;
            }

            var textContentLength = node.textContent.trim().length;
            if (textContentLength < 140) {
                return false;
            }

            score += Math.sqrt(textContentLength - 140);

            if (score > 20) {
                return true;
            }
            return false;
        });
    },

    /**
     * 执行解析
     *
     * 解析步骤:
     *  1. 通过删除脚本标记，CSS等来准备文档。
     *  2. 构建可读性的DOM树。
     *  3. 从当前的dom树中获取文章内容。
     *  4. 用新的DOM树代替当前的DOM树。
     *  5. 解析成功。
     *
     * @return void
     **/
    parse: function () {
        // 根据配置选项，避免解析过大的文档
        if (this._maxElemsToParse > 0) {
            var numTags = this._doc.getElementsByTagName("*").length;
            if (numTags > this._maxElemsToParse) {
                throw new Error("Aborting parsing document; " + numTags + " elements found");
            }
        }

        // 移除所有的script标签
        this._removeScripts(this._doc);

        // 预处理
        this._prepDocument();

        // 从 metadata 获取文章的摘要和作者信息
        var metadata = this._getArticleMetadata();
        this._articleTitle = metadata.title;

        // 提取文章正文
        var articleContent = this._grabArticle();
        if (!articleContent)
            return null;

        this.log("Grabbed: " + articleContent.innerHTML);

        this._postProcessContent(articleContent);

        // If we haven't found an excerpt in the article's metadata, use the article's
        // first paragraph as the excerpt. This is used for displaying a preview of
        // the article's content.
        // 如果我们没有在文章的元数据中找到摘录，请使用文章的第一段作为摘录。 这用于显示文章内容的预览。
        if (!metadata.excerpt) {
            var paragraphs = articleContent.getElementsByTagName("p");
            if (paragraphs.length > 0) {
                metadata.excerpt = paragraphs[0].textContent.trim();
            }
        }

        var textContent = articleContent.textContent;
        return {
            title: this._articleTitle,
            byline: metadata.byline || this._articleByline,
            dir: this._articleDir,
            content: articleContent.innerHTML,
            textContent: textContent,
            length: textContent.length,
            excerpt: metadata.excerpt,
        };
    }
};

if (typeof module === "object") {
    module.exports = Readability;
}