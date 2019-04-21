/**
 * Convert HTML examples from <script> syntax to JSM imports
 * referencing modules generated by modularize.js
 * @author oparisy / https://github.com/oparisy
 */

var fs = require('fs');
var path = require('path');
var posthtml = require('posthtml');
var recast = require('recast');

var srcFolder = __dirname + '/../examples/';
var jsFolder = __dirname + '/../examples/js/';
var jsmFolder = __dirname + '/../examples/jsm/';
var dstFolder = __dirname + '/../examples/jsm/html/';

const encoding = 'utf8';
const verbose = false;

// Name of JS tools (as found in examples/js)
const jsNames = new Set(listFiles(jsFolder, "js").map(basename));

// Relative paths of JSM tools (as generated by modularize.js)
const jsmTools = new Set(listFiles(jsmFolder, "js").map(f => 'js' + f));

// Name of JSM tools
const jsmNames = new Set(Array.from(jsmTools).map(basename));

// Non-JSM tools whitelist (those imports can be left as is)
const nonJSMTools = new Set(['js/WebGL.js', 'js/libs/stats.min.js']);

// Examples HTML files to process
//var files = ['webgl_loader_gltf.html'];
var files = fs.readdirSync(srcFolder).filter(f => f.endsWith('.html'));

// examples/js imports which were not available as JSM modules
var missing = new Set();

var success = 0;
var converted = new Set();

// Main loop
for (var i = 0; i < files.length; i++) {

	if (!fs.existsSync(dstFolder)) {
		fs.mkdirSync(dstFolder);
	}

	var file = files[i];
	if (convert(file)) {
		success++;
		converted.add(file);
	}
}

generateFilesJS(converted, srcFolder + 'files.js', dstFolder + 'files.js');

// Done
console.log(success + ' examples converted out of ' + files.length);



// Convert an HTML example/ file to a module-importing one
function convert(path) {
	var contents = fs.readFileSync(srcFolder + path, encoding);

	// Parse and transform HTML
	try {
		missing.clear();
		var result = posthtml().use(modularize).process(contents, { sync: true });
	} catch (err) {
		console.log('Error while processing ' + file, verbose ? err : '')
		return false;
	}

	// Only save result if conversion could take place
	if (missing.size == 0) {
		fs.writeFileSync(dstFolder + path, result.html, encoding);
		console.log(path + ' was successfully modularized');
		return true;
	} else {
		log('Missing modules for ' + path + ': ' + Array.from(missing).join(', '));
		return false;
	}
}

// A PostHTML transformation
function modularize(tree) {

	// Classify and collect scripts
	var imports = []
	var threejsInclude = null;
	var mainScript = null;

	tree.match({ tag: 'script' }, (node) => {
		var importSet = new Set()
		if (node.attrs && node.attrs.src === '../build/three.js' && !node.content) {
			// The build/threejs inclusion
			// Removed, will become an import in main script
			threejsInclude = node;
			return removeTag(node)
		} else if (node.attrs && node.attrs.src && nonJSMTools.has(node.attrs.src) && !node.content) {
			// A whitelisted tool inclusion => kept as is
			return node;
		} else if (node.attrs && node.attrs.src && node.attrs.src.startsWith('js/') && !node.content) {
			// An examples/js tool inclusion
			// Removed, will become an import from examples/jsm in main script
			var importPath = node.attrs.src;
			if (!importSet.has(importPath)) {
				importSet.add(importPath);
				imports.push(importPath);
			}
			return removeTag(node)
		} else if (!node.attrs && node.content) {
			// The main script
			// will be rewritten below to include imports and remove THREE prefixes
			mainScript = node;
			return node;
		} else {
			// Should not happen
			throw new Error('Unexpected <script> structure' + node);
		}
	});

	// Sanity checks
	if (!threejsInclude) {
		throw new Error('Unexpected: no three.js inclusion <script> encountered');
	}
	if (!mainScript) {
		throw new Error('Unexpected: no main <script> encountered');
	}

	// Make the main script a module
	mainScript.attrs = { type: 'module' };

	// Invoke JavaScript rewriting
	var code = mainScript.content.join('');
	mainScript.content = rewriteMainScript(code, imports)

	return tree;

	function removeTag(node) {
		node.tag = false;
		node.content = [];
		return node;
	}
}

function rewriteMainScript(code, moduleImports) {
	// Required imports from core three.js
	var coreImports = new Set();

	var ast = recast.parse(code);

	// Visit and manipulate the AST here
	// See https://github.com/benjamn/ast-types/blob/master/def/core.ts
	// See types.visit(ast...) at https://github.com/benjamn/ast-types
	// See https://github.com/benjamn/recast/issues/101#issuecomment-66134019
	recast.visit(ast, {
		visitNewExpression: function (path) {
			var node = path.node;
			var callee = node.callee;

			if (callee.type === 'MemberExpression') {
				// Sanity checks
				if (callee.object.type !== 'Identifier') {
					throw new Error('Unexpected type for MemberExpression object: ' + callee.object.type);
				}
				if (callee.property.type !== 'Identifier') {
					throw new Error('Unexpected type for MemberExpression property: ' + callee.property.type);
				}
				if (callee.object.name !== 'THREE') {
					throw new Error('Unexpected NewExpression on ' + callee.object.name);
				}

				// OK, this is a "new THREE.XXX" expression. Is this a core or examples/js import?
				var propName = callee.property.name;
				var isCore = !jsNames.has(propName);
				var isJsm = jsmNames.has(propName);
				log('NewExpression on MemberExpression: object=' + callee.object.name
					+ ', property=' + callee.property.name + ', isCore=' + isCore + ', isJsm=' + isJsm);

				//  Sanity check flags combinations
				if (isCore) {
					if (isJsm) {
						throw new Error('Unexpected discrepancy');
					}
					coreImports.add(propName);
				} else {
					if (!isJsm) {
						missing.add(propName);
					}
				}

				// Rewrite AST: new THREE.XXX => new XXX
				node.callee = callee.property
			}

			else if (node.callee.type === 'Identifier') {
				// Leave this alone (probably a standard constructor or a whitelisted tool)
				log('NewExpression on Identifier: name=' + callee.name);
			}

			else {
				throw new Error('Unexpected NewExpression callee of type ' + node.callee.type)
			}

			// Continue visiting down this subtree
			this.traverse(path);
		}
	});

	// Now that the AST was fully visited, create required module imports
	var imports = []
	imports.push(buildASTImport(Array.from(coreImports).sort(), '../build/three.module.js'));
	moduleImports.forEach(mi => {
		var path = mi.replace(/^js/, './jsm');
		imports.push(buildASTImport([ basename(mi)] , path));
	});

	// Add those imports at the script beginning
	if (ast.type !== 'File') {
		throw new Error('Unexpected AST structure, root is a ' + ast.type);
	}
	imports.reverse().forEach(i => ast.program.body.unshift(i));

	// We are done => print code back
	// Options try to respect typical examples formatting
	return recast.print(ast, {useTabs: true, tabWidth: 4}).code;
}

function buildASTImport(what, from) {
	// See node_modules/ast-types/gen/builders.d.ts
	var b = recast.types.builders;
	var specifiers = what.map(s => b.importSpecifier(b.identifier(s)));
	var source = b.literal(from);
	return b.importDeclaration(specifiers, source);
}

// Return the relative paths of all files of extension "ext" in "folder" and its subfolder
function listFiles(folder, ext) {
	var result = [];
	rec(folder, '');
	return result;

	function rec(f, relPath) {
		fs.readdirSync(f).forEach((name) => {
			var entryPath = path.resolve(f, name);
			var stat = fs.statSync(entryPath);
			var itemRelPath = relPath + '/' + name;
			if (stat && stat.isDirectory()) {
				rec(entryPath, itemRelPath);
			} else if (path.extname(entryPath).endsWith('.' + ext)) {
				result.push(itemRelPath);
			}
		});
	}
}

// Generate a "files.js" listing for successfully converted files
function generateFilesJS(converted, src, dst) {
	// Take advantage of the fact that this file is nearly JSON-compliant
	var contents = fs.readFileSync(src, encoding);
	var json = JSON.parse(contents.replace(/^var files = /, '').replace(';', '').replace('"misc_lookat",', '"misc_lookat"'));

	// Filter each category entries
	for (category in json) {
		var filtered = json[category].filter(e => converted.has(e + '.html'));
		json[category] = filtered;
	}

	// Write result back to disk
	var result = 'var files = ' + JSON.stringify(json, null, '\t') + ';';
	fs.writeFileSync(dst, result, encoding);
}

function basename(f) {
	return f.split('/').pop().replace('.js','');
}

function log(msg) {
	if (verbose) {
		console.log(msg);
	}
}