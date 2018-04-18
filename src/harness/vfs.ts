// tslint:disable:no-null-keyword
namespace vfs {
    // file type
    const S_IFMT            = 0o170000; // file type
    const S_IFSOCK          = 0o140000; // socket
    const S_IFLNK           = 0o120000; // symbolic link
    const S_IFREG           = 0o100000; // regular file
    const S_IFBLK           = 0o060000; // block device
    const S_IFDIR           = 0o040000; // directory
    const S_IFCHR           = 0o020000; // character device
    const S_IFIFO           = 0o010000; // FIFO

    let devCount = 0; // A monotonically increasing count of device ids
    let inoCount = 0; // A monotonically increasing count of inodes

    /**
     * Represents a virtual POSIX-like file system.
     */
    export class FileSystem {
        /** Indicates whether the file system is case-sensitive (`false`) or case-insensitive (`true`). */
        public readonly ignoreCase: boolean;

        /** Gets the comparison function used to compare two paths. */
        public readonly stringComparer: (a: string, b: string) => number;

        // lazy-initialized state that should be mutable even if the FileSystem is frozen.
        private _lazy: {
            links?: core.SortedMap<string, Inode>;
            shadows?: Map<number, Inode>;
            meta?: core.Metadata;
        } = {};

        private _cwd: string; // current working directory
        private _time: number | Date | (() => number | Date);
        private _shadowRoot: FileSystem | undefined;
        private _dirStack: string[] | undefined;

        constructor(ignoreCase: boolean, options: FileSystemOptions = {}) {
            const { time = -1, files, meta } = options;
            this.ignoreCase = ignoreCase;
            this.stringComparer = this.ignoreCase ? vpath.compareCaseInsensitive : vpath.compareCaseSensitive;
            this._time = time;

            if (meta) {
                for (const key of Object.keys(meta)) {
                    this.meta.set(key, meta[key]);
                }
            }

            if (files) {
                this._applyFiles(files, /*dirname*/ "");
            }

            let cwd = options.cwd;
            if ((!cwd || !vpath.isRoot(cwd)) && this._lazy.links) {
                const iterator = core.getIterator(this._lazy.links.keys());
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const name = i.value;
                        cwd = cwd ? vpath.resolve(name, cwd) : name;
                        break;
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            }

            if (cwd) {
                vpath.validate(cwd, vpath.ValidationFlags.Absolute);
                this.mkdirpSync(cwd);
            }

            this._cwd = cwd || "";
        }

        /**
         * Gets metadata for this `FileSystem`.
         */
        public get meta(): core.Metadata {
            if (!this._lazy.meta) {
                this._lazy.meta = new core.Metadata(this._shadowRoot ? this._shadowRoot.meta : undefined);
            }
            return this._lazy.meta;
        }

        /**
         * Gets a value indicating whether the file system is read-only.
         */
        public get isReadonly() {
            return Object.isFrozen(this);
        }

        /**
         * Makes the file system read-only.
         */
        public makeReadonly() {
            Object.freeze(this);
            return this;
        }

        /**
         * Gets the file system shadowed by this file system.
         */
        public get shadowRoot() {
            return this._shadowRoot;
        }

        /**
         * Gets a shadow of this file system.
         */
        public shadow(ignoreCase = this.ignoreCase) {
            if (!this.isReadonly) throw new Error("Cannot shadow a mutable file system.");
            if (ignoreCase && !this.ignoreCase) throw new Error("Cannot create a case-insensitive file system from a case-sensitive one.");
            const fs = new FileSystem(ignoreCase, { time: this._time });
            fs._shadowRoot = this;
            fs._cwd = this._cwd;
            return fs;
        }

        /**
         * Gets or sets the timestamp (in milliseconds) used for file status, returning the previous timestamp.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/time.html
         */
        public time(value?: number | Date | (() => number | Date)): number {
            if (value !== undefined && this.isReadonly) throw new IOError("EPERM");
            let result = this._time;
            if (typeof result === "function") result = result();
            if (typeof result === "object") result = result.getTime();
            if (result === -1) result = Date.now();
            if (value !== undefined) {
                this._time = value;
            }
            return result;
        }

        /**
         * Gets the metadata object for a path.
         * @param path
         */
        public filemeta(path: string): core.Metadata {
            const { node } = this._walk(this._resolve(path));
            if (!node) throw new IOError("ENOENT");
            return this._filemeta(node);
        }

        private _filemeta(node: Inode): core.Metadata {
            if (!node.meta) {
                const parentMeta = node.shadowRoot && this._shadowRoot && this._shadowRoot._filemeta(node.shadowRoot);
                node.meta = new core.Metadata(parentMeta);
            }
            return node.meta;
        }

        /**
         * Get the pathname of the current working directory.
         *
         * @link - http://pubs.opengroup.org/onlinepubs/9699919799/functions/getcwd.html
         */
        public cwd() {
            if (!this._cwd) throw new Error("The current working directory has not been set.");
            const { node } = this._walk(this._cwd);
            if (!node) throw new IOError("ENOENT");
            if (!isDirectory(node)) throw new IOError("ENOTDIR");
            return this._cwd;
        }

        /**
         * Changes the current working directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chdir.html
         */
        public chdir(path: string) {
            if (this.isReadonly) throw new IOError("EPERM");
            path = this._resolve(path);
            const { node } = this._walk(path);
            if (!node) throw new IOError("ENOENT");
            if (!isDirectory(node)) throw new IOError("ENOTDIR");
            this._cwd = path;
        }

        /**
         * Pushes the current directory onto the directory stack and changes the current working directory to the supplied path.
         */
        public pushd(path?: string) {
            if (this.isReadonly) throw new IOError("EPERM");
            if (path) path = this._resolve(path);
            if (this._cwd) {
                if (!this._dirStack) this._dirStack = [];
                this._dirStack.push(this._cwd);
            }
            if (path && path !== this._cwd) {
                this.chdir(path);
            }
        }

        /**
         * Pops the previous directory from the location stack and changes the current directory to that directory.
         */
        public popd() {
            if (this.isReadonly) throw new IOError("EPERM");
            const path = this._dirStack && this._dirStack.pop();
            if (path) {
                this.chdir(path);
            }
        }

        /**
         * Update the file system with a set of files.
         */
        public apply(files: FileSet) {
            this._applyFiles(files, this._cwd);
        }

        /**
         * Scan file system entries along a path. If `path` is a symbolic link, it is dereferenced.
         * @param path The path at which to start the scan.
         * @param axis The axis along which to traverse.
         * @param traversal The traversal scheme to use.
         */
        public scanSync(path: string, axis: Axis, traversal: Traversal) {
            path = this._resolve(path);
            const results: string[] = [];
            this._scan(path, this._stat(this._walk(path)), axis, traversal, /*noFollow*/ false, results);
            return results;
        }

        /**
         * Scan file system entries along a path.
         * @param path The path at which to start the scan.
         * @param axis The axis along which to traverse.
         * @param traversal The traversal scheme to use.
         */
        public lscanSync(path: string, axis: Axis, traversal: Traversal) {
            path = this._resolve(path);
            const results: string[] = [];
            this._scan(path, this._stat(this._walk(path, /*noFollow*/ true)), axis, traversal, /*noFollow*/ true, results);
            return results;
        }

        private _scan(path: string, stats: Stats, axis: Axis, traversal: Traversal, noFollow: boolean, results: string[]) {
            if (axis === "ancestors-or-self" || axis === "self" || axis === "descendants-or-self") {
                if (!traversal.accept || traversal.accept(path, stats)) {
                    results.push(path);
                }
            }
            if (axis === "ancestors-or-self" || axis === "ancestors") {
                const dirname = vpath.dirname(path);
                if (dirname !== path) {
                    try {
                        const stats = this._stat(this._walk(dirname, noFollow));
                        if (!traversal.traverse || traversal.traverse(dirname, stats)) {
                            this._scan(dirname, stats, "ancestors-or-self", traversal, noFollow, results);
                        }
                    }
                    catch { /*ignored*/ }
                }
            }
            if (axis === "descendants-or-self" || axis === "descendants") {
                if (stats.isDirectory() && (!traversal.traverse || traversal.traverse(path, stats))) {
                    for (const file of this.readdirSync(path)) {
                        try {
                            const childpath = vpath.combine(path, file);
                            const stats = this._stat(this._walk(childpath, noFollow));
                            this._scan(childpath, stats, "descendants-or-self", traversal, noFollow, results);
                        }
                        catch { /*ignored*/ }
                    }
                }
            }
        }

        /**
         * Mounts a physical or virtual file system at a location in this virtual file system.
         *
         * @param source The path in the physical (or other virtual) file system.
         * @param target The path in this virtual file system.
         * @param resolver An object used to resolve files in `source`.
         */
        public mountSync(source: string, target: string, resolver: FileSystemResolver) {
            if (this.isReadonly) throw new IOError("EROFS");

            source = vpath.validate(source, vpath.ValidationFlags.Absolute);

            const { parent, links, node: existingNode, basename } = this._walk(this._resolve(target), /*noFollow*/ true);
            if (existingNode) throw new IOError("EEXIST");

            const time = this.time();
            const node = this._mknod(parent ? parent.dev : ++devCount, S_IFDIR, /*mode*/ 0o777, time);
            node.source = source;
            node.resolver = resolver;
            this._addLink(parent, links, basename, node, time);
        }

        /**
         * Recursively remove all files and directories underneath the provided path.
         */
        public rimrafSync(path: string) {
            try {
                const stats = this.lstatSync(path);
                if (stats.isFile() || stats.isSymbolicLink()) {
                    this.unlinkSync(path);
                }
                else if (stats.isDirectory()) {
                    for (const file of this.readdirSync(path)) {
                        this.rimrafSync(vpath.combine(path, file));
                    }
                    this.rmdirSync(path);
                }
            }
            catch (e) {
                if (e.code === "ENOENT") return;
                throw e;
            }
        }

        /**
         * Make a directory and all of its parent paths (if they don't exist).
         */
        public mkdirpSync(path: string) {
            path = this._resolve(path);
            try {
                this.mkdirSync(path);
            }
            catch (e) {
                if (e.code === "ENOENT") {
                    this.mkdirpSync(vpath.dirname(path));
                    this.mkdirSync(path);
                }
                else if (e.code !== "EEXIST") {
                    throw e;
                }
            }
        }

        /**
         * Print diagnostic information about the structure of the file system to the console.
         */
        public debugPrint(): void {
            let result = "";
            const printLinks = (dirname: string | undefined, links: core.SortedMap<string, Inode>) => {
                const iterator = core.getIterator(links);
                try {
                    for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                        const [name, node] = i.value;
                        const path = dirname ? vpath.combine(dirname, name) : name;
                        const marker = vpath.compare(this._cwd, path, this.ignoreCase) === 0 ? "*" : " ";
                        if (result) result += "\n";
                        result += marker;
                        if (isDirectory(node)) {
                            result += vpath.addTrailingSeparator(path);
                            printLinks(path, this._getLinks(node));
                        }
                        else if (isFile(node)) {
                            result += path;
                        }
                        else if (isSymlink(node)) {
                            result += path + " -> " + node.symlink;
                        }
                    }
                }
                finally {
                    core.closeIterator(iterator);
                }
            };
            printLinks(/*dirname*/ undefined, this._getRootLinks());
            console.log(result);
        }

        // POSIX API (aligns with NodeJS "fs" module API)

        /**
         * Get file status. If `path` is a symbolic link, it is dereferenced.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/stat.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public statSync(path: string) {
            return this._stat(this._walk(this._resolve(path)));
        }

        /**
         * Get file status.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lstat.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public lstatSync(path: string) {
            return this._stat(this._walk(this._resolve(path), /*noFollow*/ true));
        }

        private _stat(entry: WalkResult) {
            const node = entry.node;
            if (!node) throw new IOError("ENOENT");
            return new Stats(
                node.dev,
                node.ino,
                node.mode,
                node.nlink,
                /*rdev*/ 0,
                /*size*/ isFile(node) ? this._getSize(node) : isSymlink(node) ? node.symlink.length : 0,
                /*blksize*/ 4096,
                /*blocks*/ 0,
                node.atimeMs,
                node.mtimeMs,
                node.ctimeMs,
                node.birthtimeMs,
            );
        }

        /**
         * Read a directory. If `path` is a symbolic link, it is dereferenced.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readdirSync(path: string) {
            const { node } = this._walk(this._resolve(path));
            if (!node) throw new IOError("ENOENT");
            if (!isDirectory(node)) throw new IOError("ENOTDIR");
            return Array.from(this._getLinks(node).keys());
        }

        /**
         * Make a directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public mkdirSync(path: string) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { parent, links, node: existingNode, basename } = this._walk(this._resolve(path), /*noFollow*/ true);
            if (existingNode) throw new IOError("EEXIST");

            const time = this.time();
            const node = this._mknod(parent ? parent.dev : ++devCount, S_IFDIR, /*mode*/ 0o777, time);
            this._addLink(parent, links, basename, node, time);
        }

        /**
         * Remove a directory.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rmdir.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public rmdirSync(path: string) {
            if (this.isReadonly) throw new IOError("EROFS");
            path = this._resolve(path);

            const { parent, links, node, basename } = this._walk(path, /*noFollow*/ true);
            if (!parent) throw new IOError("EPERM");
            if (!isDirectory(node)) throw new IOError("ENOTDIR");
            if (this._getLinks(node).size !== 0) throw new IOError("ENOTEMPTY");

            this._removeLink(parent, links, basename, node);
        }

        /**
         * Link one file to another file (also known as a "hard link").
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public linkSync(oldpath: string, newpath: string) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { node } = this._walk(this._resolve(oldpath));
            if (!node) throw new IOError("ENOENT");
            if (isDirectory(node)) throw new IOError("EPERM");

            const { parent, links, basename, node: existingNode } = this._walk(this._resolve(newpath), /*noFollow*/ true);
            if (!parent) throw new IOError("EPERM");
            if (existingNode) throw new IOError("EEXIST");

            this._addLink(parent, links, basename, node);
        }

        /**
         * Remove a directory entry.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/unlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public unlinkSync(path: string) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { parent, links, node, basename } = this._walk(this._resolve(path), /*noFollow*/ true);
            if (!parent) throw new IOError("EPERM");
            if (!node) throw new IOError("ENOENT");
            if (isDirectory(node)) throw new IOError("EISDIR");

            this._removeLink(parent, links, basename, node);
        }

        /**
         * Rename a file.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public renameSync(oldpath: string, newpath: string) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { parent: oldParent, links: oldParentLinks, node, basename: oldBasename } = this._walk(this._resolve(oldpath), /*noFollow*/ true);
            if (!oldParent) throw new IOError("EPERM");
            if (!node) throw new IOError("ENOENT");

            const { parent: newParent, links: newParentLinks, node: existingNode, basename: newBasename } = this._walk(this._resolve(newpath), /*noFollow*/ true);
            if (!newParent) throw new IOError("EPERM");

            const time = this.time();
            if (existingNode) {
                if (isDirectory(node)) {
                    if (!isDirectory(existingNode)) throw new IOError("ENOTDIR");
                    if (this._getLinks(existingNode).size > 0) throw new IOError("ENOTEMPTY");
                }
                else {
                    if (isDirectory(existingNode)) throw new IOError("EISDIR");
                }
                this._removeLink(newParent, newParentLinks, newBasename, existingNode, time);
            }

            this._replaceLink(oldParent, oldParentLinks, oldBasename, newParent, newParentLinks, newBasename, node, time);
        }

        /**
         * Make a symbolic link.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/symlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public symlinkSync(target: string, linkpath: string) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { parent, links, node: existingNode, basename } = this._walk(this._resolve(linkpath), /*noFollow*/ true);
            if (!parent) throw new IOError("EPERM");
            if (existingNode) throw new IOError("EEXIST");

            const time = this.time();
            const node = this._mknod(parent.dev, S_IFLNK, /*mode*/ 0o666, time);
            node.symlink = vpath.validate(target, vpath.ValidationFlags.RelativeOrAbsolute);
            this._addLink(parent, links, basename, node, time);
        }

        /**
         * Read the contents of a symbolic link.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readlink.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readlinkSync(path: string) {
            const { node } = this._walk(this._resolve(path), /*noFollow*/ true);
            if (!node) throw new IOError("ENOENT");
            if (!isSymlink(node)) throw new IOError("EINVAL");
            return node.symlink;
        }

        /**
         * Resolve a pathname.
         *
         * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/realpath.html
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public realpathSync(path: string) {
            const { realpath } = this._walk(this._resolve(path));
            return realpath;
        }

        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string, encoding?: null): Buffer;
        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string, encoding: string): string;
        /**
         * Read from a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public readFileSync(path: string, encoding?: string | null): string | Buffer;
        public readFileSync(path: string, encoding: string | null = null) {
            const { node } = this._walk(this._resolve(path));
            if (!node) throw new IOError("ENOENT");
            if (isDirectory(node)) throw new IOError("EISDIR");
            if (!isFile(node)) throw new IOError("EBADF");

            const buffer = this._getBuffer(node).slice();
            return encoding ? buffer.toString(encoding) : buffer;
        }

        /**
         * Write to a file.
         *
         * NOTE: do not rename this method as it is intended to align with the same named export of the "fs" module.
         */
        public writeFileSync(path: string, data: string | Buffer, encoding: string | null = null) {
            if (this.isReadonly) throw new IOError("EROFS");

            const { parent, links, node: existingNode, basename } = this._walk(this._resolve(path), /*noFollow*/ false);
            if (!parent) throw new IOError("EPERM");

            const time = this.time();
            let node = existingNode;
            if (!node) {
                node = this._mknod(parent.dev, S_IFREG, 0o666, time);
                this._addLink(parent, links, basename, node, time);
            }

            if (isDirectory(node)) throw new IOError("EISDIR");
            if (!isFile(node)) throw new IOError("EBADF");
            node.buffer = Buffer.isBuffer(data) ? data.slice() : Buffer.from("" + data, encoding || "utf8");
            node.size = node.buffer.byteLength;
            node.mtimeMs = time;
            node.ctimeMs = time;
        }

        private _mknod(dev: number, type: typeof S_IFREG, mode: number, time?: number): FileInode;
        private _mknod(dev: number, type: typeof S_IFDIR, mode: number, time?: number): DirectoryInode;
        private _mknod(dev: number, type: typeof S_IFLNK, mode: number, time?: number): SymlinkInode;
        private _mknod(dev: number, type: number, mode: number, time = this.time()) {
            return <Inode>{
                dev,
                ino: ++inoCount,
                mode: (mode & ~S_IFMT & ~0o022 & 0o7777) | (type & S_IFMT),
                atimeMs: time,
                mtimeMs: time,
                ctimeMs: time,
                birthtimeMs: time,
                nlink: 0
            };
        }

        private _addLink(parent: DirectoryInode | undefined, links: core.SortedMap<string, Inode>, name: string, node: Inode, time = this.time()) {
            links.set(name, node);
            node.nlink++;
            node.ctimeMs = time;
            if (parent) parent.mtimeMs = time;
            if (!parent && !this._cwd) this._cwd = name;
        }

        private _removeLink(parent: DirectoryInode | undefined, links: core.SortedMap<string, Inode>, name: string, node: Inode, time = this.time()) {
            links.delete(name);
            node.nlink--;
            node.ctimeMs = time;
            if (parent) parent.mtimeMs = time;
        }

        private _replaceLink(oldParent: DirectoryInode, oldLinks: core.SortedMap<string, Inode>, oldName: string, newParent: DirectoryInode, newLinks: core.SortedMap<string, Inode>, newName: string, node: Inode, time: number) {
            if (oldParent !== newParent) {
                this._removeLink(oldParent, oldLinks, oldName, node, time);
                this._addLink(newParent, newLinks, newName, node, time);
            }
            else {
                oldLinks.delete(oldName);
                oldLinks.set(newName, node);
                oldParent.mtimeMs = time;
                newParent.mtimeMs = time;
            }
        }

        private _getRootLinks() {
            if (!this._lazy.links) {
                this._lazy.links = new core.SortedMap<string, Inode>(this.stringComparer);
                if (this._shadowRoot) {
                    this._copyShadowLinks(this._shadowRoot._getRootLinks(), this._lazy.links);
                }
                this._lazy.links = this._lazy.links;
            }
            return this._lazy.links;
        }

        private _getLinks(node: DirectoryInode) {
            if (!node.links) {
                const links = new core.SortedMap<string, Inode>(this.stringComparer);
                const { source, resolver } = node;
                if (source && resolver) {
                    node.source = undefined;
                    node.resolver = undefined;
                    for (const name of resolver.readdirSync(source)) {
                        const path = vpath.combine(source, name);
                        const stats = resolver.statSync(path);
                        switch (stats.mode & S_IFMT) {
                            case S_IFDIR:
                                const dir = this._mknod(node.dev, S_IFDIR, 0o777);
                                dir.source = vpath.combine(source, name);
                                dir.resolver = resolver;
                                this._addLink(node, links, name, dir);
                                break;
                            case S_IFREG:
                                const file = this._mknod(node.dev, S_IFREG, 0o666);
                                file.source = vpath.combine(source, name);
                                file.resolver = resolver;
                                file.size = stats.size;
                                this._addLink(node, links, name, file);
                                break;
                        }
                    }
                }
                else if (this._shadowRoot && node.shadowRoot) {
                    this._copyShadowLinks(this._shadowRoot._getLinks(node.shadowRoot), links);
                }
                node.links = links;
            }
            return node.links;
        }

        private _getShadow(root: DirectoryInode): DirectoryInode;
        private _getShadow(root: Inode): Inode;
        private _getShadow(root: Inode) {
            const shadows = this._lazy.shadows || (this._lazy.shadows = new Map<number, Inode>());

            let shadow = shadows.get(root.ino);
            if (!shadow) {
                shadow = <Inode>{
                    dev: root.dev,
                    ino: root.ino,
                    mode: root.mode,
                    atimeMs: root.atimeMs,
                    mtimeMs: root.mtimeMs,
                    ctimeMs: root.ctimeMs,
                    birthtimeMs: root.birthtimeMs,
                    nlink: root.nlink,
                    shadowRoot: root
                };

                if (isSymlink(root)) (<SymlinkInode>shadow).symlink = root.symlink;
                shadows.set(shadow.ino, shadow);
            }

            return shadow;
        }

        private _copyShadowLinks(source: ReadonlyMap<string, Inode>, target: core.SortedMap<string, Inode>) {
            const iterator = core.getIterator(source);
            try {
                for (let i = core.nextResult(iterator); i; i = core.nextResult(iterator)) {
                    const [name, root] = i.value;
                    target.set(name, this._getShadow(root));
                }
            }
            finally {
                core.closeIterator(iterator);
            }
        }

        private _getSize(node: FileInode): number {
            if (node.buffer) return node.buffer.byteLength;
            if (node.size !== undefined) return node.size;
            if (node.source && node.resolver) return node.size = node.resolver.statSync(node.source).size;
            if (this._shadowRoot && node.shadowRoot) return node.size = this._shadowRoot._getSize(node.shadowRoot);
            return 0;
        }

        private _getBuffer(node: FileInode): Buffer {
            if (!node.buffer) {
                const { source, resolver } = node;
                if (source && resolver) {
                    node.source = undefined;
                    node.resolver = undefined;
                    node.size = undefined;
                    node.buffer = resolver.readFileSync(source);
                }
                else if (this._shadowRoot && node.shadowRoot) {
                    node.buffer = this._shadowRoot._getBuffer(node.shadowRoot);
                }
                else {
                    node.buffer = Buffer.allocUnsafe(0);
                }
            }
            return node.buffer;
        }

        /**
         * Walk a path to its end.
         *
         * @param path The path to follow.
         * @param noFollow A value indicating whether to *not* dereference a symbolic link at the
         * end of a path.
         * @param allowPartial A value indicating whether to return a partial result if the node
         * at the end of the path cannot be found.
         *
         * @link http://man7.org/linux/man-pages/man7/path_resolution.7.html
         */
        private _walk(path: string, noFollow?: boolean): WalkResult {
            let links = this._getRootLinks();
            let parent: DirectoryInode | undefined;
            let components = vpath.parse(path);
            let step = 0;
            let depth = 0;
            while (true) {
                if (depth >= 40) throw new IOError("ELOOP");
                const lastStep = step === components.length - 1;
                const basename = components[step];
                const node = links.get(basename);
                if (lastStep && (noFollow || !isSymlink(node))) {
                    return { realpath: vpath.format(components), basename, parent, links, node };
                }
                if (node === undefined) {
                    throw new IOError("ENOENT");
                }
                if (isSymlink(node)) {
                    const dirname = vpath.format(components.slice(0, step));
                    const symlink = vpath.resolve(dirname, node.symlink);
                    links = this._getRootLinks();
                    parent = undefined;
                    components = vpath.parse(symlink).concat(components.slice(step + 1));
                    step = 0;
                    depth++;
                    continue;
                }
                if (isDirectory(node)) {
                    links = this._getLinks(node);
                    parent = node;
                    step++;
                    continue;
                }
                throw new IOError("ENOTDIR");
            }
        }

        /**
         * Resolve a path relative to the current working directory.
         */
        private _resolve(path: string) {
            return this._cwd
                ? vpath.resolve(this._cwd, vpath.validate(path, vpath.ValidationFlags.RelativeOrAbsolute))
                : vpath.validate(path, vpath.ValidationFlags.Absolute);
        }

        private _applyFiles(files: FileSet, dirname: string) {
            const deferred: [Symlink | Link | Mount, string][] = [];
            this._applyFilesWorker(files, dirname, deferred);
            for (const [entry, path] of deferred) {
                this.mkdirpSync(vpath.dirname(path));
                this.pushd(vpath.dirname(path));
                if (entry instanceof Symlink) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be symbolic links.");
                    }
                    this.symlinkSync(entry.symlink, path);
                    this._applyFileExtendedOptions(path, entry);
                }
                else if (entry instanceof Link) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be hard links.");
                    }
                    this.linkSync(entry.path, path);
                }
                else {
                    this.mountSync(entry.source, path, entry.resolver);
                    this._applyFileExtendedOptions(path, entry);
                }
                this.popd();
            }
        }

        private _applyFileExtendedOptions(path: string, entry: Directory | File | Symlink | Mount) {
            const { meta } = entry;
            if (meta !== undefined) {
                const filemeta = this.filemeta(path);
                for (const key of Object.keys(meta)) {
                    filemeta.set(key, meta[key]);
                }
            }
        }

        private _applyFilesWorker(files: FileSet, dirname: string, deferred: [Symlink | Link | Mount, string][]) {
            for (const key of Object.keys(files)) {
                const value = this._normalizeFileSetEntry(files[key]);
                const path = dirname ? vpath.resolve(dirname, key) : key;
                vpath.validate(path, vpath.ValidationFlags.Absolute);
                if (value === null || value === undefined) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be deleted.");
                    }
                    this.rimrafSync(path);
                }
                else if (value instanceof File) {
                    if (this.stringComparer(vpath.dirname(path), path) === 0) {
                        throw new TypeError("Roots cannot be files.");
                    }
                    this.mkdirpSync(vpath.dirname(path));
                    this.writeFileSync(path, value.data, value.encoding);
                    this._applyFileExtendedOptions(path, value);
                }
                else if (value instanceof Directory) {
                    this.mkdirpSync(path);
                    this._applyFileExtendedOptions(path, value);
                    this._applyFilesWorker(value.files, path, deferred);
                }
                else {
                    deferred.push([value as Symlink | Link | Mount, path]);
                }
            }
        }

        private _normalizeFileSetEntry(value: FileSet[string]) {
            if (value === undefined ||
                value === null ||
                value instanceof Directory ||
                value instanceof File ||
                value instanceof Link ||
                value instanceof Symlink ||
                value instanceof Mount) {
                return value;
            }
            return typeof value === "string" || Buffer.isBuffer(value) ? new File(value) : new Directory(value);
        }
    }

    export interface FileSystemOptions {
        time?: number | Date | (() => number | Date);
        files?: FileSet;
        cwd?: string;
        meta?: Record<string, any>;
    }

    export type Axis = "ancestors" | "ancestors-or-self" | "self" | "descendants-or-self" | "descendants";

    export interface Traversal {
        traverse?(path: string, stats: Stats): boolean;
        accept?(path: string, stats: Stats): boolean;
    }

    export interface FileSystemResolver {
        statSync(path: string): { mode: number; size: number; };
        readdirSync(path: string): string[];
        readFileSync(path: string): Buffer;
    }

    export class Stats {
        public dev: number;
        public ino: number;
        public mode: number;
        public nlink: number;
        public uid: number;
        public gid: number;
        public rdev: number;
        public size: number;
        public blksize: number;
        public blocks: number;
        public atimeMs: number;
        public mtimeMs: number;
        public ctimeMs: number;
        public birthtimeMs: number;
        public atime: Date;
        public mtime: Date;
        public ctime: Date;
        public birthtime: Date;

        constructor();
        constructor(dev: number, ino: number, mode: number, nlink: number, rdev: number, size: number, blksize: number, blocks: number, atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number);
        constructor(dev = 0, ino = 0, mode = 0, nlink = 0, rdev = 0, size = 0, blksize = 0, blocks = 0, atimeMs = 0, mtimeMs = 0, ctimeMs = 0, birthtimeMs = 0) {
            this.dev = dev;
            this.ino = ino;
            this.mode = mode;
            this.nlink = nlink;
            this.uid = 0;
            this.gid = 0;
            this.rdev = rdev;
            this.size = size;
            this.blksize = blksize;
            this.blocks = blocks;
            this.atimeMs = atimeMs;
            this.mtimeMs = mtimeMs;
            this.ctimeMs = ctimeMs;
            this.birthtimeMs = birthtimeMs;
            this.atime = new Date(this.atimeMs);
            this.mtime = new Date(this.mtimeMs);
            this.ctime = new Date(this.ctimeMs);
            this.birthtime = new Date(this.birthtimeMs);
        }

        public isFile() { return (this.mode & S_IFMT) === S_IFREG; }
        public isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
        public isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
        public isBlockDevice() { return (this.mode & S_IFMT) === S_IFBLK; }
        public isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
        public isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
        public isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
    }

    // tslint:disable-next-line:variable-name
    export const IOErrorMessages = Object.freeze({
        EACCES: "access denied",
        EIO: "an I/O error occurred",
        ENOENT: "no such file or directory",
        EEXIST: "file already exists",
        ELOOP: "too many symbolic links encountered",
        ENOTDIR: "no such directory",
        EISDIR: "path is a directory",
        EBADF: "invalid file descriptor",
        EINVAL: "invalid value",
        ENOTEMPTY: "directory not empty",
        EPERM: "operation not permitted",
        EROFS: "file system is read-only"
    });

    export class IOError extends Error {
        public readonly code: string;

        constructor(code: keyof typeof IOErrorMessages) {
            super(`${code}: ${IOErrorMessages[code]}`);
            this.name = "Error";
            this.code = code;
        }
    }

    /**
     * A template used to populate files, directories, links, etc. in a virtual file system.
     */
    export interface FileSet {
        [name: string]: DirectoryLike | FileLike | Link | Symlink | Mount | null | undefined;
    }

    export type DirectoryLike = FileSet | Directory;
    export type FileLike = File | Buffer | string;

    /** Extended options for a directory in a `FileSet` */
    export class Directory {
        public readonly files: FileSet;
        public readonly meta: Record<string, any> | undefined;
        constructor(files: FileSet, { meta }: { meta?: Record<string, any> } = {}) {
            this.files = files;
            this.meta = meta;
        }
    }

    /** Extended options for a file in a `FileSet` */
    export class File {
        public readonly data: Buffer | string;
        public readonly encoding: string | undefined;
        public readonly meta: Record<string, any> | undefined;
        constructor(data: Buffer | string, { meta, encoding }: { encoding?: string, meta?: Record<string, any> } = {}) {
            this.data = data;
            this.encoding = encoding;
            this.meta = meta;
        }
    }

    /** Extended options for a hard link in a `FileSet` */
    export class Link {
        public readonly path: string;
        constructor(path: string) {
            this.path = path;
        }
    }

    /** Extended options for a symbolic link in a `FileSet` */
    export class Symlink {
        public readonly symlink: string;
        public readonly meta: Record<string, any> | undefined;
        constructor(symlink: string, { meta }: { meta?: Record<string, any> } = {}) {
            this.symlink = symlink;
            this.meta = meta;
        }
    }

    /** Extended options for mounting a virtual copy of an external file system via a `FileSet` */
    export class Mount {
        public readonly source: string;
        public readonly resolver: FileSystemResolver;
        public readonly meta: Record<string, any> | undefined;
        constructor(source: string, resolver: FileSystemResolver, { meta }: { meta?: Record<string, any> } = {}) {
            this.source = source;
            this.resolver = resolver;
            this.meta = meta;
        }
    }

    // a generic POSIX inode
    type Inode = FileInode | DirectoryInode | SymlinkInode;

    interface FileInode {
        dev: number; // device id
        ino: number; // inode id
        mode: number; // file mode
        atimeMs: number; // access time
        mtimeMs: number; // modified time
        ctimeMs: number; // status change time
        birthtimeMs: number; // creation time
        nlink: number; // number of hard links
        size?: number;
        buffer?: Buffer;
        source?: string;
        resolver?: FileSystemResolver;
        shadowRoot?: FileInode;
        meta?: core.Metadata;
    }

    interface DirectoryInode {
        dev: number; // device id
        ino: number; // inode id
        mode: number; // file mode
        atimeMs: number; // access time
        mtimeMs: number; // modified time
        ctimeMs: number; // status change time
        birthtimeMs: number; // creation time
        nlink: number; // number of hard links
        links?: core.SortedMap<string, Inode>;
        source?: string;
        resolver?: FileSystemResolver;
        shadowRoot?: DirectoryInode;
        meta?: core.Metadata;
    }

    interface SymlinkInode {
        dev: number; // device id
        ino: number; // inode id
        mode: number; // file mode
        atimeMs: number; // access time
        mtimeMs: number; // modified time
        ctimeMs: number; // status change time
        birthtimeMs: number; // creation time
        nlink: number; // number of hard links
        symlink?: string;
        shadowRoot?: SymlinkInode;
        meta?: core.Metadata;
    }

    function isFile(node: Inode | undefined): node is FileInode {
        return node !== undefined && (node.mode & S_IFMT) === S_IFREG;
    }

    function isDirectory(node: Inode | undefined): node is DirectoryInode {
        return node !== undefined && (node.mode & S_IFMT) === S_IFDIR;
    }

    function isSymlink(node: Inode | undefined): node is SymlinkInode {
        return node !== undefined && (node.mode & S_IFMT) === S_IFLNK;
    }

    interface WalkResult {
        realpath: string;
        basename: string;
        parent: DirectoryInode | undefined;
        links: core.SortedMap<string, Inode> | undefined;
        node: Inode | undefined;
    }
}
// tslint:enable:no-null-keyword