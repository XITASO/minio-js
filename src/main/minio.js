/*
 * Minio Javascript Library for Amazon S3 Compatible Cloud Storage, (C) 2015 Minio, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('source-map-support').install()

import fs from 'fs'
import Crypto from 'crypto'
import Http from 'http'
import Https from 'https'
import Stream from 'stream'
import Through2 from 'through2'
import BlockStream2 from 'block-stream2'
import Url from 'url'
import Xml from 'xml'
import Moment from 'moment'
import async from 'async'
import mkdirp from 'mkdirp'
import path from 'path'
import _ from 'lodash'

import { isValidPrefix, isValidACL, isValidEndpoint, isValidBucketName,
         isValidPort, isValidObjectName, isAmazonEndpoint, getScope,
         uriEscape, uriResourceEscape, isBoolean, isFunction, isNumber,
         isString, isObject, isNullOrUndefined, pipesetup,
         readableStream, isReadableStream } from './helpers.js';

import { signV4, presignSignatureV4, postPresignSignatureV4 } from './signing.js';

import * as transformers from './transformers'

import * as errors from './errors.js';

var Package = require('../../package.json');

export default class Client {
  constructor(params) {
    // Default values if not specified.
    if (!params.insecure) params.insecure = false
    if (!params.port) params.port = 0
    // Validate input params.
    if (!isValidEndpoint(params.endPoint)) {
      throw new errors.InvalidEndPointError(`endPoint ${params.endPoint} is invalid`)
    }
    if (!isValidPort(params.port)) {
      throw new errors.InvalidArgumentError(`port ${params.port} is invalid`)
    }
    if (!isBoolean(params.insecure)) {
      throw new errors.InvalidArgumentError(`insecure option is of invalid type should be of type boolean true/false`)
    }

    var host = params.endPoint
    // Virtual host style is enabled by default.
    var virtualHostStyle = true
    if (!isAmazonEndpoint(host)) {
      virtualHostStyle = false
    }

    var port = params.port;
    var protocol = ''
    var transport;
    if (params.insecure === false) {
      transport = Https
      protocol = 'https:'
      if (port === 0) {
        port = 443
      }
    } else {
      transport = Http
      protocol = 'http:'
      if (port === 0) {
        port = 80
      }
    }

    // if custom transport is set, use it.
    if (params.transport) {
      if (!isObject(params.transport)) {
        throw new errors.InvalidArgumentError('transport should be of type "object"')
      }
      transport = params.transport
    }

    // User Agent should always following the below style.
    // Please open an issue to discuss any new changes here.
    //
    //       Minio (OS; ARCH) LIB/VER APP/VER
    //
    var libraryComments = `(${process.platform}; ${process.arch})`
    var libraryAgent = `Minio ${libraryComments} minio-js/${Package.version}`
    // User agent block ends.

    var newParams = {
      host: host,
      port: port,
      protocol: protocol,
      accessKey: params.accessKey,
      secretKey: params.secretKey,
      userAgent: `${libraryAgent}`,
    }
    if (!newParams.accessKey) newParams.accessKey = ''
    if (!newParams.secretKey) newParams.secretKey = ''
    this.anonymous = !newParams.accessKey || !newParams.secretKey
    this.params = newParams
    this.transport = transport
    this.virtualHostStyle = virtualHostStyle
    this.regionMap = {}
    this.minimumPartSize = 5*1024*1024
    this.maximumPartSize = 5*1024*1024*1024
    this.maxObjectSize = 5*1024*1024*1024*1024
  }

  // returns *options* object that can be used with http.request()
  // Takes care of constructing virtual-host-style or path-style hostname
  getRequestOptions(opts) {
    var method = opts.method
    var bucketName = opts.bucketName
    var objectName = opts.objectName
    var headers = opts.headers
    var query = opts.query

    var reqOptions = {method}
    reqOptions.headers = {}

    if (this.params.port) reqOptions.port = this.params.port
    reqOptions.protocol = this.params.protocol

    if (objectName) {
      objectName = `${uriResourceEscape(objectName)}`
    }

    reqOptions.path = '/'
    if (!this.virtualHostStyle || !opts.bucketName) {
      // we will do path-style requests for
      // 1. minio server
      // 2. listBuckets() where opts.bucketName is not defined
      reqOptions.host = this.params.host
      if (bucketName) reqOptions.path = `/${bucketName}`
      if (objectName) reqOptions.path = `/${bucketName}/${objectName}`
    } else {
      // for AWS we will always do virtual-host-style
      reqOptions.host = `${this.params.host}`
      if (bucketName) reqOptions.host = `${bucketName}.${this.params.host}`
      if (objectName) reqOptions.path = `/${objectName}`
    }
    if (query) reqOptions.path += `?${query}`
    reqOptions.headers.host = reqOptions.host
    if ((reqOptions.protocol === 'http:' && reqOptions.port !== 80) ||
        (reqOptions.protocol === 'https:' && reqOptions.port !== 443)) {
      reqOptions.headers.host = `${reqOptions.host}:${reqOptions.port}`
    }
    if (headers) {
      // have all header keys in lower case - to make signing easy
      _.map(headers, (v, k) => reqOptions.headers[k.toLowerCase()] = v)
    }

    return reqOptions
  }

  // Set application specific information.
  //
  // Generates User-Agent in the following style.
  //
  //       Minio (OS; ARCH) LIB/VER APP/VER
  //
  // __Arguments__
  // * `appName` _string_ - Application name.
  // * `appVersion` _string_ - Application version.
  setAppInfo(appName, appVersion) {
    if (!isString(appName)) {
      throw new TypeError(`Invalid appName: ${appName}`)
    }
    if (appName.trim() === '') {
      throw new errors.InvalidArgumentError('Input appName cannot be empty.')
    }
    if (!isString(appVersion)) {
      throw new TypeError(`Invalid appName: ${appVersion}`)
    }
    if (appVersion.trim() === '') {
      throw new errors.InvalidArgumentError('Input appVersion cannot be empty.')
    }
    this.params.userAgent = `${this.params.userAgent} ${appName}/${appVersion}`
  }

  // partSize will be atleast minimumPartSize or a multiple of minimumPartSize
  // for size <= 50000 MB partSize is always 5MB (10000*5 = 50000)
  // for size > 50000MB partSize will be a multiple of 5MB
  // for size = 5TB partSize will be 525MB
  calculatePartSize(size) {
    if (!isNumber(size)) {
      throw new TypeError('size should be of type "number"')
    }
    if (size > this.maxObjectSize) {
      throw new TypeError(`size should not be more than ${this.maxObjectSize}`)
    }
    var partSize = Math.ceil(size/10000)
    partSize = Math.ceil(partSize/this.minimumPartSize) * this.minimumPartSize
    return partSize
  }

  // makeRequest is the primitive used by all the apis for making S3 requests.
  // payload can be empty string in case of no payload.
  // statusCode is the expected statusCode. If response.statusCode does not match
  // we parse the XML error and call the callback with the error message.

  // makeRequest/makeRequestStream is used by all the calls except
  // makeBucket and getBucketRegion which use path-style requests and standard
  // region 'us-east-1'
  makeRequest(options, payload, statusCode, cb) {
    if (!isObject(options)) {
      throw new TypeError('options should be of type "object"')
    }
    if (!isString(payload) && !isObject(payload)) {
      // Buffer is of type 'object'
      throw new TypeError('payload should be of type "string" or "Buffer"')
    }
    if (!isNumber(statusCode)) {
      throw new TypeError('statusCode should be of type "number"')
    }
    if(!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    if (!options.headers) options.headers = {}
    options.headers['content-length'] = payload.length
    var sha256sum = ''
    if (!this.anonymous) sha256sum = Crypto.createHash('sha256').update(payload).digest('hex')
    var stream = readableStream(payload)
    this.makeRequestStream(options, stream, sha256sum, statusCode, cb)
  }

  // log the request, response, error
  logHTTP(reqOptions, response, err) {
    // if no logstreamer available return.
    if (!this.logStream) return
    if (!isObject(reqOptions)) {
      throw new TypeError('reqOptions should be of type "object"')
    }
    if (response && !isReadableStream(response)) {
      throw new TypeError('response should be of type "Stream"')
    }
    if (err && !(err instanceof Error)) {
      throw new TypeError('err should be of type "Error"')
    }
    var logHeaders = (headers) => {
      _.forEach(headers, (v, k) => {
        if (k == 'authorization') {
          var redacter = new RegExp('Signature=([0-9a-f]+)')
          v = v.replace(redacter, 'Signature=**REDACTED**')
        }
        this.logStream.write(`${k}: ${v}\n`)
      })
      this.logStream.write('\n')
    }.bind(this)
    this.logStream.write(`REQUEST: ${reqOptions.method} ${reqOptions.path}\n`)
    logHeaders(reqOptions.headers)
    if (response) {
      this.logStream.write(`RESPONSE: ${response.statusCode}\n`)
      logHeaders(response.headers)
    }
    if (err) {
      this.logStream.write('ERROR BODY:\n')
      var errJSON = JSON.stringify(err, null, '\t')
      this.logStream.write(`${errJSON}\n`)
    }
  }

  // Enable tracing
  traceOn(stream) {
    if (!stream) stream = process.stdout
    this.logStream = stream
  }

  // Disable tracing
  traceOff() {
    this.logStream = null
  }

  // makeRequestStream will be used directly instead of makeRequest in case the payload
  // is available as a stream. for ex. putObject
  makeRequestStream(options, stream, sha256sum, statusCode, cb) {
    if (!isObject(options)) {
      throw new TypeError('options should be of type "object"')
    }
    if (!isReadableStream(stream)) {
      throw new errors.InvalidArgumentError('stream should be a readable Stream')
    }
    if (!isString(sha256sum)) {
      throw new TypeError('sha256sum should be of type "string"')
    }
    if (!isNumber(statusCode)) {
      throw new TypeError('statusCode should be of type "number"')
    }
    if(!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    // sha256sum will be empty for anonymous requests
    if (sha256sum.length === 0 && !this.anonymous) {
      throw new errors.InvalidArgumentError(`sha256sum cannot be empty for authenticated requests`)
    }
    if (sha256sum.length !== 64 && !this.anonymous) {
      throw new errors.InvalidArgumentError(`Invalid sha256sum : ${sha256sum}`)
    }

    var reqOptions = this.getRequestOptions(options)
    var _makeRequest = (e, region) => {
      if (e) return cb(e)
      if (!this.anonymous) {
        reqOptions.headers['x-amz-date'] = Moment().utc().format('YYYYMMDDTHHmmss') + 'Z'
        reqOptions.headers['x-amz-content-sha256'] = sha256sum
        var authorization = signV4(reqOptions, this.params.accessKey, this.params.secretKey, region)
        reqOptions.headers.authorization = authorization
      }
      var req = this.transport.request(reqOptions, response => {
        if (statusCode !== response.statusCode) {
          // For an incorrect region, S3 server always sends back 400.
          // But we will do cache invalidation for all errors so that,
          // in future, if AWS S3 decides to send a different status code or
          // XML error code we will still work fine.
          delete(this.regionMap[options.bucketName])
          var errorTransformer = transformers.getErrorTransformer(response)
          pipesetup(response, errorTransformer)
            .on('error', e => {
              this.logHTTP(reqOptions, response, e)
              cb(e)
            })
          return
        }
        this.logHTTP(reqOptions, response)
        cb(null, response)
      })
      pipesetup(stream, req)
        .on('error', e => {
          this.logHTTP(reqOptions, null, e)
          cb(e)
        })
    }
    // for operations where bucketName is not relevant like listBuckets()
    if (!options.bucketName) return _makeRequest(null, 'us-east-1')
    this.getBucketRegion(options.bucketName, _makeRequest)
  }

  // gets the region of the bucket
  getBucketRegion(bucketName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name : ${bucketName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('cb should be of type "function"')
    }
    if (this.regionMap[bucketName]) return cb(null, this.regionMap[bucketName])
    var reqOptions = {}
    reqOptions.method = 'GET'
    reqOptions.host = this.params.host
    reqOptions.port = this.params.port
    reqOptions.protocol = this.params.protocol
    reqOptions.path = `/${bucketName}?location`
    if (!this.anonymous) {
      reqOptions.headers = {}
      reqOptions.headers.host = reqOptions.host
      if ((reqOptions.protocol === 'http:' && reqOptions.port !== 80) ||
          (reqOptions.protocol === 'https:' && reqOptions.port !== 443)) {
        reqOptions.headers.host = `${reqOptions.host}:${reqOptions.port}`
      }
      reqOptions.headers['x-amz-date'] = Moment().utc().format('YYYYMMDDTHHmmss') + 'Z'
      reqOptions.headers['x-amz-content-sha256'] = Crypto.createHash('sha256').digest('hex')
      var authorization = signV4(reqOptions, this.params.accessKey, this.params.secretKey, 'us-east-1')
      reqOptions.headers.authorization = authorization
    }
    var statusCode = 200
    var req = this.transport.request(reqOptions)
    req.on('error', e => {
      this.logHTTP(reqOptions, null, e)
      cb(e)
    })
    req.on('response', response => {
      if (statusCode !== response.statusCode) {
        var errorTransformer = transformers.getErrorTransformer(response)
        pipesetup(response, errorTransformer)
          .on('error', e => {
            this.logHTTP(reqOptions, response, e)
            cb(e)
          })
        return
      }
      var transformer = transformers.getBucketRegionTransformer()
      var region = 'us-east-1'
      pipesetup(response, transformer)
        .on('error', cb)
        .on('data', data => {
          if (data) region = data
        })
        .on('end', () => {
          this.regionMap[bucketName] = region
          cb(null, region)
        })
      this.logHTTP(reqOptions, response)
    })
    req.end()
  }

  // Creates the bucket `bucketName`.
  //
  // __Arguments__
  // * `bucketName` _string_ - Name of the bucket
  // * `acl` _string_ - cannedACL which can have the values _private_, _public-read_, _public-read-write_, _authenticated-read_.
  // * `region` _string_ - region valid values are _us-west-1_, _us-west-2_,  _eu-west-1_, _eu-central-1_, _ap-southeast-1_, _ap-northeast-1_, _ap-southeast-2_, _sa-east-1_.
  // * `callback(err)` _function_ - callback function with `err` as the error argument. `err` is null if the bucket is successfully created.
  makeBucket(bucketName, acl, region, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isString(acl)) {
      throw new TypeError('acl should be of type "string"')
    }
    if (!isString(region)) {
      throw new TypeError('region should be of type "string"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }

    // if acl is empty string, we default to 'private'.
    if (!acl) acl = 'private'

    // Verify if acl is valid.
    if (!isValidACL(acl)) {
      throw new errors.InvalidACLError(`Invalid acl ${acl}, allowed values: 'private' 'public-read' 'public-read-write' 'authenticated-read'`)
    }

    var payload = ''
    if (region) {
      var createBucketConfiguration = []
      createBucketConfiguration.push({
        _attr: {
          xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/'
        }
      })
      createBucketConfiguration.push({
        LocationConstraint: region
      })
      var payloadObject = {
        CreateBucketConfiguration: createBucketConfiguration
      }
      payload = Xml(payloadObject)
    }
    var method = 'PUT'
    var headers = {'x-amz-acl': acl}

    var reqOptions = this.getRequestOptions({method, bucketName, headers})
    if (!this.anonymous) {
      reqOptions.headers['x-amz-date'] = Moment().utc().format('YYYYMMDDTHHmmss') + 'Z'
      reqOptions.headers['x-amz-content-sha256'] = Crypto.createHash('sha256').update(payload).digest('hex')
      var authorization = signV4(reqOptions, this.params.accessKey, this.params.secretKey, 'us-east-1')
      reqOptions.headers.authorization = authorization
    }
    var statusCode = 200
    var req = this.transport.request(reqOptions, response => {
      var errorTransformer = transformers.getErrorTransformer(response)
      if (statusCode !== response.statusCode) {
        pipesetup(response, errorTransformer)
        .on('error', e => {
          this.logHTTP(reqOptions, response, e)
          cb(e)
        })
        return
      }
      this.logHTTP(reqOptions, response)
      cb()
    })
    req.on('error', e => {
      this.logHTTP(reqOptions, null, e)
      cb(e)
    })
    req.write(payload)
    req.end()
  }

  // List of buckets created.
  //
  // __Arguments__
  // * `callback(err, buckets)` _function_ - callback function with error as the first argument. `buckets` is an array of bucket information
  //
  // `buckets` array element:
  // * `bucket.name` _string_ : bucket name
  // * `bucket.creationDate` _string_: date when bucket was created
  listBuckets(cb) {
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    var method = 'GET'
    this.makeRequest({method}, '', 200, (e, response) => {
      if (e) return cb(e)
      var transformer = transformers.getListBucketTransformer()
      var buckets
      pipesetup(response, transformer)
        .on('data', result => buckets = result)
        .on('error', e => cb(e))
        .on('end', () => cb(null, buckets))
    })
  }

  // Returns a stream that emits objects that are partially uploaded.
  //
  // __Arguments__
  // * `bucketname` _string_: name of the bucket
  // * `prefix` _string_: prefix of the object names that are partially uploaded
  // * `recursive` bool: directory style listing when false, recursive listing when true
  //
  // __Return Value__
  // * `stream` _Stream_ : emits objects of the format:
  //   * `object.key` _string_: name of the object
  //   * `object.uploadId` _string_: upload ID of the object
  //   * `object.size` _Integer_: size of the partially uploaded object
  listIncompleteUploads(bucket, prefix, recursive) {
    if (!isValidBucketName(bucket)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucket)
    }
    if (prefix && !isValidPrefix(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`)
    }
    if (recursive && !isBoolean(recursive)) {
      throw new TypeError('recursive should be of type "boolean"')
    }
    var delimiter = recursive ? '' : '/'
    var dummyTransformer = transformers.getDummyTransformer()
    var listNext = (keyMarker, uploadIdMarker) => {
      this.listIncompleteUploadsQuery(bucket, prefix, keyMarker, uploadIdMarker, delimiter)
        .on('error', e => dummyTransformer.emit('error', e))
        .on('data', result => {
          result.prefixes.forEach(prefix => dummyTransformer.write(prefix))
          async.eachSeries(result.uploads, (upload, cb) => {
            this.listParts(bucket, upload.key, upload.uploadId, (err, parts) => {
              if (err) return cb(err)
              upload.size = parts.reduce((acc, item) => acc + item.size, 0)
              dummyTransformer.write(upload)
              cb()
            })
          }, err => {
            if (err) {
              dummyTransformer.emit('error', e)
              dummyTransformer.end()
              return
            }
            if (result.isTruncated) {
              listNext(result.nextKeyMarker, result.nextUploadIdMarker)
              return
            }
            dummyTransformer.end() // signal 'end'
          })
        })
    }
    listNext('', '')
    return dummyTransformer
  }

  // To check if a bucket already exists.
  //
  // __Arguments__
  // * `bucketName` _string_ : name of the bucket
  // * `callback(err)` _function_ : `err` is `null` if the bucket exists
  bucketExists(bucketName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    var method = 'HEAD'
    this.makeRequest({method, bucketName}, '', 200, cb)
  }

  // Remove a bucket.
  //
  // __Arguments__
  // * `bucketName` _string_ : name of the bucket
  // * `callback(err)` _function_ : `err` is `null` if the bucket is removed successfully.
  removeBucket(bucketName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    var method = 'DELETE'
    this.makeRequest({method, bucketName}, '', 204, (e) => {
      // If the bucket was successfully removed, remove the region map entry.
      if (!e) delete(this.regionMap[bucketName])
      cb(e)
    })
  }

  // get a bucket's ACL.
  //
  // __Arguments__
  // * `bucketName` _string_ : name of the bucket
  // * `callback(err, acl)` _function_ : `err` is not `null` in case of error. `acl` _string_ is the cannedACL which can have the values _private_, _public-read_, _public-read-write_, _authenticated-read_.
  getBucketACL(bucketName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    var method = 'GET'
    var query = 'acl'
    this.makeRequest({method, bucketName, query}, '', 200, (e, response) => {
      if (e) return cb(e)
      var transformer = transformers.getAclTransformer()
      pipesetup(response, transformer)
        .on('error', e => cb(e))
        .on('data', data => {
          var perm = data.acl.reduce((acc, grant) => {
            if (grant.grantee.uri === 'http://acs.amazonaws.com/groups/global/AllUsers') {
              if (grant.permission === 'READ') {
                acc.publicRead = true
              } else if (grant.permission === 'WRITE') {
                acc.publicWrite = true
              }
            } else if (grant.grantee.uri === 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers') {
              if (grant.permission === 'READ') {
                acc.authenticatedRead = true
              } else if (grant.permission === 'WRITE') {
                acc.authenticatedWrite = true
              }
            }
            return acc
          }, {})
          var cannedACL = 'unsupported-acl'
          if (perm.publicRead && perm.publicWrite && !perm.authenticatedRead && !perm.authenticatedWrite) {
            cannedACL = 'public-read-write'
          } else if (perm.publicRead && !perm.publicWrite && !perm.authenticatedRead && !perm.authenticatedWrite) {
            cannedACL = 'public-read'
          } else if (!perm.publicRead && !perm.publicWrite && perm.authenticatedRead && !perm.authenticatedWrite) {
            cannedACL = 'authenticated-read'
          } else if (!perm.publicRead && !perm.publicWrite && !perm.authenticatedRead && !perm.authenticatedWrite) {
            cannedACL = 'private'
          }
          cb(null, cannedACL)
        })
    })
  }

  // set a bucket's ACL.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `acl` _string_: acl can be _private_, _public-read_, _public-read-write_, _authenticated-read_
  // * `callback(err)` _function_: callback is called with error or `null`
  setBucketACL(bucketName, acl, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isString(acl)) {
      throw new TypeError('acl should be of type "string"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    if (!isValidACL(acl)) {
      throw new errors.InvalidACLError(`invalid acl ${acl}, allowed values: 'private' 'public-read' 'public-read-write' 'authenticated-read'`)
    }

    var query = 'acl'
    var method = 'PUT'
    var headers = {'x-amz-acl': acl}
    this.makeRequest({method, bucketName, query, headers}, '', 200, cb)
  }

  // Remove the partially uploaded object.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `callback(err)` _function_: callback function is called with non `null` value in case of error
  removeIncompleteUpload(bucketName, objectName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.isValidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }

    async.waterfall([
      callback => this.findUploadId(bucketName, objectName, callback),
      (uploadId, callback) => {
        var method = 'DELETE'
        var query = `uploadId=${uploadId}`
        this.makeRequest({method, bucketName, objectName, query}, '', 204, callback)
      }
    ], cb)
  }

  // Callback is called with `error` in case of error or `null` in case of success
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `filePath` _string_: path to which the object data will be written to
  // * `callback(err)` _function_: callback is called with `err` in case of error.
  fGetObject(bucketName, objectName, filePath, cb) {
    // Input validation.
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(filePath)) {
      throw new TypeError('filePath should be of type "string"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }

    // Internal data.
    var partFile
    var partFileStream
    var objStat

    // Rename wrapper.
    var rename = () => {
      fs.rename(partFile, filePath, cb)
    }

    async.waterfall([
      cb => this.statObject(bucketName, objectName, cb),
      (result, cb) => {
        objStat = result
        var dir = path.dirname(filePath)
        // If file is in current directory skip.
        if (dir === '.') return cb()
        // Create any missing top level directories.
        mkdirp(dir, cb)
      },
      (ignore, cb) => {
        partFile = `${filePath}.${objStat.etag}.part.minio`
        fs.stat(partFile, (e, stats) => {
          var offset = 0
          if (e) {
            partFileStream = fs.createWriteStream(partFile, {flags: 'w'})
          } else {
            if (objStat.size === stats.size) return rename()
            offset = stats.size
            partFileStream = fs.createWriteStream(partFile, {flags: 'a'})
          }
          this.getPartialObject(bucketName, objectName, offset, 0, cb)
        })
      },
      (downloadStream, cb) => {
        pipesetup(downloadStream, partFileStream)
          .on('error', e => cb(e))
          .on('finish', cb)
      },
      cb => fs.stat(partFile, cb),
      (stats, cb) => {
        if (stats.size === objStat.size) return cb()
        cb(new Error('Size mismatch between downloaded file and the object'))
      }
    ], rename)
  }

  // Callback is called with readable stream of the object content.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `callback(err, stream)` _function_: callback is called with `err` in case of error. `stream` is the object content stream
  getObject(bucketName, objectName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    this.getPartialObject(bucketName, objectName, 0, 0, cb)
  }

  // Callback is called with readable stream of the partial object content.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `offset` _number_: offset of the object from where the stream will start
  // * `length` _number_: length of the object that will be read in the stream
  // * `callback(err, stream)` _function_: callback is called with `err` in case of error. `stream` is the object content stream
  getPartialObject(bucketName, objectName, offset, length, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isNumber(offset)) {
      throw new TypeError('offset should be of type "number"')
    }
    if (!isNumber(length)) {
      throw new TypeError('length should be of type "number"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }

    var range = ''
    if (offset || length) {
      if (offset) {
        range = `bytes=${+offset}-`
      } else {
        range = 'bytes=0-'
        offset = 0
      }
      if (length) {
        range += `${(+length + offset) - 1}`
      }
    }

    var headers = {}
    if (range !== '') {
      headers.range = range
    }

    var expectedStatus = 200
    if (range) {
      expectedStatus = 206
    }
    var method = 'GET'
    this.makeRequest({method, bucketName, objectName, headers}, '', expectedStatus, cb)
  }

  // Uploads the object using contents from a file
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `filePath` _string_: file path of the file to be uploaded
  // * `contentType` _string_: content type of the object
  // * `callback(err, etag)` _function_: non null `err` indicates error, `etag` _string_ is the etag of the object uploaded.
  fPutObject(bucketName, objectName, filePath, contentType, callback) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(contentType)) {
      throw new TypeError('contentType should be of type "string"')
    }
    if (!isString(filePath)) {
      throw new TypeError('filePath should be of type "string"')
    }

    if (contentType.trim() === '') {
      contentType = 'application/octet-stream'
    }

    var size
    var partSize

    async.waterfall([
      cb => fs.stat(filePath, cb),
      (stats, cb) => {
        size = stats.size
        if (size > this.maxObjectSize) {
          return cb(new Error(`${filePath} size : ${stats.size}, max allowed size : 5TB`))
        }
        if (size < this.minimumPartSize) {
          // simple PUT request, no multipart
          var multipart = false
          var uploader = this.getUploader(bucketName, objectName, contentType, multipart)
          var hash = transformers.getHashSummer(this.anonymous)
          var start = 0
          var end = size - 1
          var autoClose = true
          if (size === 0) end = 0
          var options = {start, end, autoClose}
          pipesetup(fs.createReadStream(filePath, options), hash)
            .on('data', data => {
              var md5sum = data.md5sum
              var sha256sum = data.sha256sum
              var stream = fs.createReadStream(filePath, options)
              var uploadId = ''
              var partNumber = 0
              uploader(stream, size, sha256sum, md5sum, callback)
            })
            .on('error', e => cb(e))
          return
        }
        this.findUploadId(bucketName, objectName, cb)
      },
      (uploadId, cb) => {
        // if there was a previous incomplete upload, fetch all its uploaded parts info
        if (uploadId) return this.listParts(bucketName, objectName, uploadId,  (e, etags) =>  cb(e, uploadId, etags))
        // there was no previous upload, initiate a new one
        this.initiateNewMultipartUpload(bucketName, objectName, '', (e, uploadId) => cb(e, uploadId, []))
      },
      (uploadId, etags, cb) => {
        partSize = this.calculatePartSize(size)
        var multipart = true
        var uploader = this.getUploader(bucketName, objectName, contentType, multipart)

        // convert array to object to make things easy
        var parts = etags.reduce(function(acc, item) {
          if (!acc[item.part]) {
            acc[item.part] = item
          }
          return acc
        }, {})
        var partsDone = []
        var partNumber = 1
        var uploadedSize = 0
        async.whilst(
          () => uploadedSize < size,
          cb => {
            var part = parts[partNumber]
            var hash = transformers.getHashSummer()
            var length = partSize
            if (length > (size - uploadedSize)) {
              length = size - uploadedSize
            }
            var start = uploadedSize
            var end = uploadedSize + length - 1
            var autoClose = true
            var options = {autoClose, start, end}
            // verify md5sum of each part
            pipesetup(fs.createReadStream(filePath, options), hash)
              .on('data', data => {
                var md5sumhex = (new Buffer(data.md5sum, 'base64')).toString('hex')
                if (part && (md5sumhex === part.etag)) {
                  //md5 matches, chunk already uploaded
                  partsDone.push({part: partNumber, etag: part.etag})
                  partNumber++
                  uploadedSize += length
                  return cb()
                }
                // part is not uploaded yet, or md5 mismatch
                var stream = fs.createReadStream(filePath, options)
                uploader(uploadId, partNumber, stream, length,
                  data.sha256sum, data.md5sum, (e, etag) => {
                    if (e) return cb(e)
                    partsDone.push({part: partNumber, etag})
                    partNumber++
                    uploadedSize += length
                    return cb()
                  })
              })
              .on('error', e => cb(e))
          },
          e => {
            if (e) return cb(e)
            cb(null, partsDone, uploadId)
          }
        )
      },
      // all parts uploaded, complete the multipart upload
      (etags, uploadId, cb) => this.completeMultipartUpload(bucketName, objectName, uploadId, etags, cb)
    ], callback)
  }

  // Uploads the object.
  //
  // Uploading a stream
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `stream` _Stream_: Readable stream
  // * `size` _number_: size of the object
  // * `contentType` _string_: content type of the object
  // * `callback(err, etag)` _function_: non null `err` indicates error, `etag` _string_ is the etag of the object uploaded.
  //
  // Uploading "Buffer" or "string"
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `string or Buffer` _Stream_ or _Buffer_: Readable stream
  // * `contentType` _string_: content type of the object
  // * `callback(err, etag)` _function_: non null `err` indicates error, `etag` _string_ is the etag of the object uploaded.
  putObject(arg1, arg2, arg3, arg4, arg5, arg6) {
    var bucketName = arg1
    var objectName = arg2
    var stream
    var size
    var contentType
    var cb
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (isReadableStream(arg3)) {
      stream = arg3
      size = arg4
      contentType = arg5
      cb = arg6
    } else if (typeof(arg3) === 'string' || arg3 instanceof Buffer) {
      stream = readableStream(arg3)
      size = arg3.length
      contentType = arg4
      cb = arg5
    } else {
      throw new errors.TypeError('third argument should be of type "stream.Readable" or "Buffer" or "string"')
    }
    if (!isNumber(size)) {
      throw new TypeError('size should be of type "number"')
    }
    if (!isString(contentType)) {
      throw new TypeError('contentType should be of type "string"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    if (size < 0) {
      throw new errors.InvalidArgumentError(`size cannot be negative, given size : ${size}`)
    }

    if (contentType.trim() === '') {
      contentType = 'application/octet-stream'
    }

    if (size <= this.minimumPartSize) {
      // simple PUT request, no multipart
      var concater = transformers.getConcater()
      pipesetup(stream, concater)
        .on('error', e => cb(e))
        .on('data', chunk => {
          var multipart = false
          var uploader = this.getUploader(bucketName, objectName, contentType, multipart)
          var readStream = readableStream(chunk)
          var sha256sum = ''
          if (!this.anonymous) sha256sum = Crypto.createHash('sha256').update(chunk).digest('hex')
          var md5sum = Crypto.createHash('md5').update(chunk).digest('base64')
          uploader(readStream, chunk.length, sha256sum, md5sum, cb)
        })
      return
    }
    async.waterfall([
      cb => this.findUploadId(bucketName, objectName, cb),
      (uploadId, cb) => {
        if (uploadId) return this.listParts(bucketName, objectName, uploadId,  (e, etags) =>  cb(e, uploadId, etags))
        this.initiateNewMultipartUpload(bucketName, objectName, contentType, (e, uploadId) => cb(e, uploadId, []))
      },
      (uploadId, etags, cb) => {
        var multipartSize = this.calculatePartSize(size)
        var sizeVerifier = transformers.getSizeVerifierTransformer(size)
        var chunker = BlockStream2({size: this.minimumPartSize, zeroPadding: false})
        var chunkUploader = this.chunkUploader(bucketName, objectName, contentType, uploadId, etags, multipartSize)
        pipesetup(stream, chunker, sizeVerifier, chunkUploader)
          .on('error', e => cb(e))
          .on('data', etags => cb(null, etags, uploadId))
      },
      (etags, uploadId, cb) => this.completeMultipartUpload(bucketName, objectName, uploadId, etags, cb)
    ], cb)
  }

  // list a batch of objects
  listObjectsQuery(bucketName, prefix, marker, delimiter, maxKeys) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isString(prefix)) {
      throw new TypeError('prefix should be of type "string"')
    }
    if (!isString(marker)) {
      throw new TypeError('marker should be of type "string"')
    }
    if (!isString(delimiter)) {
      throw new TypeError('delimiter should be of type "string"')
    }
    if (!isNumber(maxKeys)) {
      throw new TypeError('maxKeys should be of type "number"')
    }
    var queries = []
      // escape every value in query string, except maxKeys
    if (prefix) {
      prefix = uriEscape(prefix)
      queries.push(`prefix=${prefix}`)
    }
    if (marker) {
      marker = uriEscape(marker)
      queries.push(`marker=${marker}`)
    }
    if (delimiter) {
      delimiter = uriEscape(delimiter)
      queries.push(`delimiter=${delimiter}`)
    }
    // no need to escape maxKeys
    if (maxKeys) {
      if (maxKeys >= 1000) {
        maxKeys = 1000
      }
      queries.push(`max-keys=${maxKeys}`)
    }
    queries.sort()
    var query = ''
    if (queries.length > 0) {
      query = `${queries.join('&')}`
    }
    var method = 'GET'
    var transformer = transformers.getListObjectsTransformer()
    this.makeRequest({method, bucketName, query}, '', 200, (e, response) => {
      if (e) return transformer.emit('error', e)
      pipesetup(response, transformer)
    })
    return transformer
  }

  // List the objects in the bucket.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `prefix` _string_: the prefix of the objects that should be listed
  // * `recursive` _bool_: `true` indicates recursive style listing and `false` indicates directory style listing delimited by '/'.
  //
  // __Return Value__
  // * `stream` _Stream_: stream emitting the objects in the bucket, the object is of the format:
  //   * `stat.key` _string_: name of the object
  //   * `stat.size` _number_: size of the object
  //   * `stat.etag` _string_: etag of the object
  //   * `stat.lastModified` _string_: modified time stamp
  listObjects(bucketName, prefix, recursive) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (prefix && !isValidPrefix(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`)
    }
    if (prefix && !isString(prefix)) {
      throw new TypeError('prefix should be of type "string"')
    }
    if (recursive && !isBoolean(recursive)) {
      throw new TypeError('recursive should be of type "boolean"')
    }
    if (!prefix) prefix = ''
    if (!recursive) recursive = false
    // if recursive is false set delimiter to '/'
    var delimiter = recursive ? '' : '/'
    var dummyTransformer = transformers.getDummyTransformer()
    var listNext = (marker) => {
      this.listObjectsQuery(bucketName, prefix, marker, delimiter, 1000)
        .on('error', e => dummyTransformer.emit('error', e))
        .on('data', result => {
          result.objects.forEach(object => {
            dummyTransformer.push(object)
          })
          if (result.isTruncated) {
            listNext(result.nextMarker)
            return
          }
          dummyTransformer.push(null) // signal 'end'
        })
    }
    listNext('')
    return dummyTransformer
  }

  // Stat information of the object.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `callback(err, stat)` _function_: `err` is not `null` in case of error, `stat` contains the object information:
  //   * `stat.size` _number_: size of the object
  //   * `stat.etag` _string_: etag of the object
  //   * `stat.contentType` _string_: Content-Type of the object
  //   * `stat.lastModified` _string_: modified time stamp
  statObject(bucketName, objectName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }

    var method = 'HEAD'
    this.makeRequest({method, bucketName, objectName}, '', 200, (e, response) => {
      if (e) return cb(e)
      var result = {
        size: +response.headers['content-length'],
        etag: response.headers.etag.replace(/^\"/g, '').replace(/\"$/g, ''),
        contentType: response.headers['content-type'],
        lastModified: response.headers['last-modified']
      }
      cb(null, result)
    })
  }

  // Remove the specified object.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `callback(err)` _function_: callback function is called with non `null` value in case of error
  removeObject(bucketName, objectName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    var method = 'DELETE'
    this.makeRequest({method, bucketName, objectName}, '', 204, cb)
  }

  // Generate a presigned URL for PUT. Using this URL, the browser can upload to S3 only with the specified object name.
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `expiry` _number_: expiry in seconds
  presignedPutObject(bucketName, objectName, expires, cb) {
    if (this.anonymous) {
      throw new errors.AnonymousRequestError('Presigned POST policy cannot be generated for anonymous requests')
    }
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isNumber(expires)) {
      throw new TypeError('expires should be of type "number"')
    }
    var method = 'PUT'
    var reqOptions = this.getRequestOptions({method, bucketName, objectName})
    var requestDate = Moment().utc()
    this.getBucketRegion(bucketName, (e, region) => {
      if (e) return cb(e)
      try {
        var url = presignSignatureV4(reqOptions, this.params.accessKey, this.params.secretKey,
                                     region, requestDate, expires)
      } catch (e) {
        return cb(e)
      }
      cb(null, url)
    })
  }

  // Generate a presigned URL for GET
  //
  // __Arguments__
  // * `bucketName` _string_: name of the bucket
  // * `objectName` _string_: name of the object
  // * `expiry` _number_: expiry in seconds
  presignedGetObject(bucketName, objectName, expires, cb) {
    if (this.anonymous) {
      throw new errors.AnonymousRequestError('Presigned GET cannot be generated for anonymous requests')
    }
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isNumber(expires)) {
      throw new TypeError('expires should be of type "number"')
    }
    var method = 'GET'
    var reqOptions = this.getRequestOptions({method, bucketName, objectName})
    var requestDate = Moment().utc()
    this.getBucketRegion(bucketName, (e, region) => {
      if (e) return cb(e)
      try {
        var url = presignSignatureV4(reqOptions, this.params.accessKey, this.params.secretKey,
                                     region, requestDate, expires)
      } catch (e) {
        return cb(e)
      }
      cb(null, url)
    })
  }

  // return PostPolicy object
  newPostPolicy() {
    return new PostPolicy()
  }

  // presignedPostPolicy can be used in situations where we want more control on the upload than what
  // presignedPutObject() provides. i.e Using presignedPostPolicy we will be able to put policy restrictions
  // on the object's `name` `bucket` `expiry` `Content-Type`
  presignedPostPolicy(postPolicy, cb) {
    if (this.anonymous) {
      throw new errors.AnonymousRequestError('Presigned POST policy cannot be generated for anonymous requests')
    }
    if (!isObject(postPolicy)) {
      throw new TypeError('postPolicy should be of type "object"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('cb should be of type "function"')
    }
    this.getBucketRegion(postPolicy.formData.bucket, (e, region) => {
      if (e) return cb(e)
      var date = Moment.utc()
      var dateStr = date.format('YYYYMMDDTHHmmss') + 'Z'

      postPolicy.policy.conditions.push(['eq', '$x-amz-date', dateStr])
      postPolicy.formData['x-amz-date'] = dateStr

      postPolicy.policy.conditions.push(['eq', '$x-amz-algorithm', 'AWS4-HMAC-SHA256'])
      postPolicy.formData['x-amz-algorithm'] = 'AWS4-HMAC-SHA256'

      postPolicy.policy.conditions.push(["eq", "$x-amz-credential", this.params.accessKey + "/" + getScope(region, date)])
      postPolicy.formData['x-amz-credential'] = this.params.accessKey + "/" + getScope(region, date)

      var policyBase64 = new Buffer(JSON.stringify(postPolicy.policy)).toString('base64')

      postPolicy.formData.policy = policyBase64

      var signature = postPresignSignatureV4(region, date, this.params.secretKey, policyBase64)

      postPolicy.formData['x-amz-signature'] = signature
      cb(null, postPolicy.formData)
    })
  }

  // Calls implemented below are related to multipart.

  // Initiate a new multipart upload.
  initiateNewMultipartUpload(bucketName, objectName, contentType, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(contentType)) {
      throw new TypeError('contentType should be of type "string"')
    }
    var method = 'POST'
    var headers = {'Content-Type': contentType}
    var query = 'uploads'
    this.makeRequest({method, bucketName, objectName, query, headers}, '', 200, (e, response) => {
      if (e) return cb(e)
      var transformer = transformers.getInitiateMultipartTransformer()
      pipesetup(response, transformer)
        .on('error', e => cb(e))
        .on('data', uploadId => cb(null, uploadId))
    })
  }

  // Complete the multipart upload. After all the parts are uploaded issuing
  // this call will aggregate the parts on the server into a single object.
  completeMultipartUpload(bucketName, objectName, uploadId, etags, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"')
    }
    if (!isObject(etags)) {
      throw new TypeError('etags should be of type "Array"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('cb should be of type "function"')
    }

    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty')
    }

    var method = 'POST'
    var query = `uploadId=${uploadId}`

    var parts = []

    etags.forEach(element => {
      parts.push({
        Part: [{
          PartNumber: element.part
        }, {
          ETag: element.etag
        }]
      })
    })

    var payloadObject = {CompleteMultipartUpload: parts}
    var payload = Xml(payloadObject)

    this.makeRequest({method, bucketName, objectName, query}, payload, 200, (e, response) => {
      if (e) return cb(e)
      var transformer = transformers.getCompleteMultipartTransformer()
      pipesetup(response, transformer)
        .on('error', e => cb(e))
        .on('data', result => cb(null, result.etag))
    })
  }

  // Get part-info of all parts of an incomplete upload specified by uploadId.
  listParts(bucketName, objectName, uploadId, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"')
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty')
    }
    var parts = []
    var listNext = (marker) => {
      this.listPartsQuery(bucketName, objectName, uploadId, marker, (e, result) => {
        if (e) {
          cb(e)
          return
        }
        parts = parts.concat(result.parts)
        if (result.isTruncated) {
          listNext(result.marker)
          return
        }
        cb(null, parts)
      })
    }
    listNext(0)
  }

  // Called by listParts to fetch a batch of part-info
  listPartsQuery(bucketName, objectName, uploadId, marker, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"')
    }
    if (!isNumber(marker)) {
      throw new TypeError('marker should be of type "number"')
    }
    if (!isFunction(cb)) {
      throw new TypeError('callback should be of type "function"')
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty')
    }
    var query = ''
    if (marker && marker !== 0) {
      query += `part-number-marker=${marker}&`
    }
    query += `uploadId=${uploadId}`

    var method = 'GET'
    this.makeRequest({method, bucketName, objectName, query}, '', 200, (e, response) => {
      if (e) return cb(e)
      var transformer = transformers.getListPartsTransformer()
      pipesetup(response, transformer)
        .on('error', e => cb(e))
        .on('data', data => cb(null, data))
    })
  }

  // Called by listIncompleteUploads to fetch a batch of incomplete uploads.
  listIncompleteUploadsQuery(bucketName, prefix, keyMarker, uploadIdMarker, delimiter) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isString(prefix)) {
      throw new TypeError('prefix should be of type "string"')
    }
    if (!isString(keyMarker)) {
      throw new TypeError('keyMarker should be of type "string"')
    }
    if (!isString(uploadIdMarker)) {
      throw new TypeError('uploadIdMarker should be of type "string"')
    }
    if (!isString(delimiter)) {
      throw new TypeError('delimiter should be of type "string"')
    }
    var queries = []
    if (prefix) {
      queries.push(`prefix=${uriEscape(prefix)}`)
    }
    if (keyMarker) {
      keyMarker = uriEscape(keyMarker)
      queries.push(`key-marker=${keyMarker}`)
    }
    if (uploadIdMarker) {
      queries.push(`upload-id-marker=${uploadIdMarker}`)
    }
    if (delimiter) {
      queries.push(`delimiter=${uriEscape(delimiter)}`)
    }
    var maxUploads = 1000
    queries.push(`max-uploads=${maxUploads}`)
    queries.sort()
    queries.unshift('uploads')
    var query = ''
    if (queries.length > 0) {
      query = `${queries.join('&')}`
    }
    var method = 'GET'
    var transformer = transformers.getListMultipartTransformer()
    this.makeRequest({method, bucketName, query}, '', 200, (e, response) => {
      if (e) return transformer.emit('error', e)
      pipesetup(response, transformer)
    })
    return transformer
  }

  // Find uploadId of an incomplete upload.
  findUploadId(bucketName, objectName, cb) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isFunction(cb)) {
      throw new TypeError('cb should be of type "function"')
    }

    var listNext = (keyMarker, uploadIdMarker) => {
      this.listIncompleteUploadsQuery(bucketName, objectName, keyMarker, uploadIdMarker, '')
        .on('error', e => cb(e))
        .on('data', result => {
          var keyFound = false
          result.uploads.forEach(upload => {
            if (upload.key === objectName) {
              cb(null, upload.uploadId)
              keyFound = true
            }
          })
          if (keyFound) {
            return
          }
          if (result.isTruncated) {
            listNext(result.nextKeyMarker, result.nextUploadIdMarker)
            return
          }
          cb(null, undefined)
        })
    }
    listNext('', '')
  }

  // Returns a stream that does multipart upload of the chunks it receives.
  chunkUploader(bucketName, objectName, contentType, uploadId, partsArray, multipartSize) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(contentType)) {
      throw new TypeError('contentType should be of type "string"')
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"')
    }
    if (!isObject(partsArray)) {
      throw new TypeError('partsArray should be of type "Array"')
    }
    if (!isNumber(multipartSize)) {
      throw new TypeError('multipartSize should be of type "number"')
    }
    if (multipartSize > this.maximumPartSize) {
      throw new errors.InvalidArgumentError(`multipartSize cannot be more than ${this.maximumPartSize}`)
    }
    var partsDone = []
    var partNumber = 1

    // convert array to object to make things easy
    var parts = partsArray.reduce(function(acc, item) {
      if (!acc[item.part]) {
        acc[item.part] = item
      }
      return acc
    }, {})

    var aggregatedSize = 0

    var aggregator = null   // aggregator is a simple through stream that aggregates
                            // chunks of minimumPartSize adding up to multipartSize

    var md5 = null
    var sha256 = null

    return Through2.obj((chunk, enc, cb) => {
      if (chunk.length > this.minimumPartSize) {
        return cb(new Error(`chunk length cannot be more than ${this.minimumPartSize}`))
      }

      // get new objects for a new part upload
      if (!aggregator) aggregator = Through2()
      if (!md5) md5 = Crypto.createHash('md5')
      if (!sha256) sha256 = Crypto.createHash('sha256')

      aggregatedSize += chunk.length
      if (aggregatedSize > multipartSize) return cb(new Error('aggregated size cannot be greater than multipartSize'))

      aggregator.write(chunk)
      md5.update(chunk)
      sha256.update(chunk)

      var done = false
      if (aggregatedSize === multipartSize) done = true
      // This is the last chunk of the stream.
      if (aggregatedSize < multipartSize && chunk.length < this.minimumPartSize) done = true

      // more chunks are expected
      if (!done) return cb()

      aggregator.end() // when aggregator is piped to another stream it emits all the chunks followed by 'end'

      var part = parts[partNumber]
      var md5sumhex = md5.digest('hex')
      if (part) {
        if (md5sumhex === part.etag) {
          // md5 matches, chunk already uploaded
          // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
          aggregator = md5 = sha256 = null
          aggregatedSize = 0
          partsDone.push({part: part.part, etag: part.etag})
          partNumber++
          return cb()
        }
        // md5 doesn't match, upload again
      }
      var sha256sum = sha256.digest('hex')
      var md5sumbase64 = (new Buffer(md5sumhex, 'hex')).toString('base64')
      var multipart = true
      var uploader = this.getUploader(bucketName, objectName, contentType, multipart)
      uploader(uploadId, partNumber, aggregator, aggregatedSize, sha256sum, md5sumbase64, (e, etag) => {
        if (e) {
          return cb(e)
        }
        // reset aggregator md5 sha256 and aggregatedSize variables for a fresh multipart upload
        aggregator = md5 = sha256 = null
        aggregatedSize = 0
        var part = {
          part: partNumber,
          etag: etag
        }
        partsDone.push(part)
        partNumber++
        cb()
      })
    }, function(cb) {
      this.push(partsDone)
      this.push(null)
      cb()
    })
  }

  // Returns a function that can be used for uploading objects.
  // If multipart === true, it returns function that is used to upload
  // a part of the multipart.
  getUploader(bucketName, objectName, contentType, multipart) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName)
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`)
    }
    if (!isString(contentType)) {
      throw new TypeError('contentType should be of type "string"')
    }
    if (!isBoolean(multipart)) {
      throw new TypeError('multipart should be of type "boolean"')
    }
    if (contentType === '') {
      contentType = 'application/octet-stream'
    }

    var validate = (stream, length, sha256sum, md5sum, cb) => {
      if (!isReadableStream(stream)) {
        throw new TypeError('stream should be of type "Stream"')
      }
      if (!isNumber(length)) {
        throw new TypeError('length should be of type "number"')
      }
      if (!isString(sha256sum)) {
        throw new TypeError('sha256sum should be of type "string"')
      }
      if (!isString(md5sum)) {
        throw new TypeError('md5sum should be of type "string"')
      }
      if (!isFunction(cb)) {
        throw new TypeError('callback should be of type "function"')
      }
    }
    var simpleUploader = (...args) => {
      validate(...args)
      var query = ''
      upload(query, ...args)
    }
    var multipartUploader = (uploadId, partNumber, ...rest) => {
      if (!isString(uploadId)) {
        throw new TypeError('uploadId should be of type "string"')
      }
      if (!isNumber(partNumber)) {
        throw new TypeError('partNumber should be of type "number"')
      }
      if (!uploadId) {
        throw new errors.InvalidArgumentError('Empty uploadId')
      }
      if (!partNumber) {
        throw new errors.InvalidArgumentError('partNumber cannot be 0')
      }
      validate(...rest)
      var query = `partNumber=${partNumber}&uploadId=${uploadId}`
      upload(query, ...rest)
    }
    var upload = (query, stream, length, sha256sum, md5sum, cb) => {
      var method = 'PUT'
      var headers = {
        'Content-Length': length,
        'Content-Type': contentType,
        'Content-MD5': md5sum
      }
      this.makeRequestStream({method, bucketName, objectName, query, headers},
                            stream, sha256sum, 200, (e, response) => {
        if (e) return cb(e)
        var etag = response.headers.etag
        if (etag) {
          etag = etag.replace(/^\"/, '').replace(/\"$/, '')
        }
        cb(null, etag)
      })
    }
    if (multipart) {
      return multipartUploader
    }
    return simpleUploader
  }
}

// Build PostPolicy object that can be signed by presignedPostPolicy
class PostPolicy {
  constructor() {
    this.policy = {
      conditions: []
    }
    this.formData = {}
  }

  // set expiration date
  setExpires(nativedate) {
    if (!nativedate) {
      throw new errrors.InvalidDateError('Invalid date : cannot be null')
    }
    var date = Moment(nativedate)

    function getExpirationString(date) {
      return date.format('YYYY-MM-DDThh:mm:ss.SSS') + 'Z'
    }
    this.policy.expiration = getExpirationString(date)
  }

  // set object name
  setKey(objectName) {
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name : ${objectName}`)
    }
    this.policy.conditions.push(['eq', '$key', objectName])
    this.formData.key = objectName
  }

  // set object name prefix, i.e policy allows any keys with this prefix
  setKeyStartsWith(prefix) {
    if (!isValidPrefix(prefix)) {
      throw new errors.InvalidPrefixError(`invalid prefix : ${prefix}`)
    }
    this.policy.conditions.push(['starts-with', '$key', prefix])
    this.formData.key = prefix
  }

  // set bucket name
  setBucket(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name : ${bucketName}`)
    }
    this.policy.conditions.push(['eq', '$bucket', bucketName])
    this.formData.bucket = bucketName
  }

  // set Content-Type
  setContentType(type) {
    if (!type) {
      throw new Error('content-type cannot be null')
    }
    this.policy.conditions.push(['eq', '$Content-Type', type])
    this.formData['Content-Type'] = type
  }

  // set minimum/maximum length of what Content-Length can be
  setContentLength(min, max) {
    if (min > max) {
      throw new Error('min cannot be more than max')
    }
    if (min < 0) {
      throw new Error('min should be > 0')
    }
    if (max < 0) {
      throw new Error('max should be > 0')
    }
    this.policy.conditions.push(['content-length-range', min, max])
  }
}
