'use strict';

const path = require('path');
const globby = require('globby');
const fs = require('fs');
const jsyaml = require('js-yaml');
const {
  getMetadataArgsStorage,
  getTreeRepository,
  getRepository,
} = require('typeorm');
const Logger = require('./logger');

/**
 * 判断是否为生产环境
 * @param {EggApplication} app EggApplication
 */
function isProdEnv(app) {
  return app.config.env === 'prod';
}

/**
 * 判断是否为本地环境
 * @param {EggApplication} app EggApplication
 */
function isLocalEnv(app) {
  return app.config.env === 'local';
}

/**
 * 读取配置文件，支持格式[js，json，yml，yaml]，且按照该顺序读取，如果已找到则不会再往下读取
 * 将配置文件转化为js对象，感谢 @zellzh 提供代码参考
 * @param {String} baseDir 项目根目录
 */
function loadOrmConfig(baseDir) {
  const fileFormats = [ 'js', 'json', 'yml', 'yaml' ];
  const ext = fileFormats.find(e => {
    return fs.existsSync(path.join(baseDir, `ormconfig.${e}`));
  });
  // file exist
  if (ext) {
    let config = null;
    const fullPath = path.join(baseDir, `ormconfig.${ext}`);
    if (ext === 'js' || ext === 'json') {
      const tmp = require(fullPath);
      if (Array.isArray(tmp)) {
        config = tmp.reduce((target, property) => {
          target[property.name] = property;
          return target;
        }, {});
      } else {
        const prop = tmp.name || 'default';
        config = { [prop]: tmp };
      }
    } else if (ext === 'yaml' || ext === 'yml') {
      config = jsyaml.safeLoad(fs.readFileSync(fullPath));
    }
    return config || {};
  }
  // file not exist
  return {};
  // return jsyaml.safeLoad(fs.readFileSync(path.join(baseDir, 'ormconfig.yaml'))) || {};
}

/**
 * 获取连接配置 对应生成 ConnectionOptions[]
 * @param {EggApplication} app EggApplication
 */
function getConnectionOptions(app) {
  // 判断是否为开发环境，开发环境需要加载TS，生产环境需要加载JS
  const isLocal = isLocalEnv(app);
  const config = app.config;
  const { typeorm } = config;
  if (!typeorm || !typeorm.client && !typeorm.clients) {
    return [];
  }
  // 如果定义了clients 则优先使用clients，弃用client
  const clientArr = typeorm.clients || [ typeorm.client ];
  // 读取根目录下的typeormconfig.yaml配置
  const entitiesConfig = loadOrmConfig(app.config.baseDir);
  return clientArr.map(e => {
    // 防止client定义时没有name属性，以及没有定义name属性值给予default
    e.name = e.name || 'default';
    // 匹配根据名称匹配实体类存放目录，请勿重名
    e.entitiesDir = entitiesConfig[e.name].entitiesDir;
    if (!e.entitiesDir) {
      app.logger.error('[typeorm]', 'entitiesDir must config, use client can set name to default');
      throw new Error('entitiesDir is empty');
    }
    // delete e.entitiesDir;
    // https://github.com/typeorm/typeorm/issues/2275
    e.entities = [ path.join(app.config.baseDir, e.entitiesDir, '**', isLocal ? '*.ts' : '*.js') ];
    // 判断是否定义了日志记录器，如果没有则使用插件默认自定义的记录器
    if (!e.logger) {
      e.logger = new Logger(app, e.logging);
    }
    return e;
  });
}

/**
 * 文件夹文件路径转换，文件首字母自动转化大写
 * app/service/foo/bar.js => [ 'foo', 'Bar' ]
 * @param {String} filepath 文件路径
 */
function camelize(filepath) {
  const properties = filepath.substring(0, filepath.lastIndexOf('.')).split('/');
  const size = properties.length;
  return properties.map((property, index) => {
    if (!/^[a-z][a-z0-9_-]*$/i.test(property)) {
      throw new Error(`${property} is not match 'a-z0-9_-' in ${filepath}`);
    }
    // use camelize, will capitalize the first letter
    // foo_bar.js > FooBar
    // fooBar.js  > FooBar
    // FooBar.js  > FooBar
    // FooBar.js  > FooBar
    property = property.replace(/[_-][a-z]/ig, s => s.substring(1).toUpperCase());
    if (index === size - 1) {
      return `${property[0].toUpperCase()}${property.substring(1)}`;
    }
    return property;
  });
}

/**
 * 驼峰转换
 * @param {String} str str
 */
function toHump(str) {
  const name = str.replace(/[\-\/\_\.](\w)/g, function(all, letter) {
    return letter.toUpperCase();
  });
  return name[0].toUpperCase() + name.substring(1);
}

/**
 * Parse files from given directories, then return an items list, each item contains properties and exports.
 * For example, parse `app/controller/group/repository.js`
 *
 * Item
 *
 * {
 *   properties: [ 'group', 'repository' ],
 *   exports: app => { ... },
 * }
 * @param {String|Array} directory directory
 * @param {String|Array} match glob match
 * @param {Boolean} expose expose exports, if true exports is null
 */
function parse(directory, match, expose = true) {
  const items = [];
  const files = Array.isArray(match) ? match : [ match ];
  const directories = Array.isArray(directory) ? directory : [ directory ];
  for (const dir of directories) {
    const filepaths = globby.sync(files, { cwd: dir });
    for (const filepath of filepaths) {
      const fullpath = path.join(directory, filepath);
      // 不是文件直接pass
      if (!fs.statSync(fullpath).isFile()) {
        continue;
      }
      // app/service/foo/bar.js => [ 'foo', 'bar' ]
      const properties = camelize(filepath);
      // app/service/foo/bar.js => service.foo.bar
      const pathname = directory.split(/[/\\]/).slice(-1) + '.' + properties.join('.');
      // prod mode don' t need this
      let exports;
      if (expose) {
        // require js module
        const obj = require(fullpath);
        // it's es module
        if (!obj) {
          continue;
        }
        // it's es module, must use export default
        if (obj.__esModule && 'default' in obj) {
          exports = obj.default;
        } else {
          continue;
        }
      }
      items.push({ properties, fullpath, pathname, exports: exports ? exports : null });
    }
  }
  return items;
}

/**
 * 代码参考自：
 * https://github.com/eggjs/egg-core/blob/74d523a9ad208bfa8d3531085811df96878d1711/lib/loader/file_loader.js
 * @param {String|Array} directory directory
 * @param {String|Array} match match
 * @param {String} connectName conntect name
 */
function load(directory, match, connectName = 'default') {
  const repo = {},
    entity = {};
  const items = parse(directory, match);
  for (const item of items) {
    // item { properties: [ 'a', 'b', 'c'], exports }
    // => target.a.b.c = exports
    item.properties.reduce((target, property, index) => {
      let obj;
      // const properties = item.properties.slice(0, index + 1).join('.');
      if (index === item.properties.length - 1) {
        obj = item.exports;
      } else {
        obj = target[property] || {};
      }
      target[property] = obj;
      return obj;
    }, entity);
    // repo
    item.properties.reduce((target, property, index) => {
      let obj;
      // const properties = item.properties.slice(0, index + 1).join('.');
      if (index === item.properties.length - 1) {
        obj = getMetadataArgsStorage()
          .trees.filter(e => e.target === item.exports)[0] ? getTreeRepository(item.exports, connectName) : getRepository(item.exports, connectName);
      } else {
        obj = target[property] || {};
      }
      target[property] = obj;
      return obj;
    }, repo);
  }
  return { repo, entity };
}

module.exports = { getConnectionOptions, loadOrmConfig, camelize, parse, load, toHump, isProdEnv, isLocalEnv };
