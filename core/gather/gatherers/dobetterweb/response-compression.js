/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
  * @fileoverview Determines optimized gzip/br/deflate filesizes for all responses by
  *   checking the content-encoding header.
  */


import {Buffer} from 'buffer';
import {gzip} from 'zlib';

import BaseGatherer from '../../base-gatherer.js';
import UrlUtils from '../../../lib/url-utils.js';
import {Sentry} from '../../../lib/sentry.js';
import {NetworkRequest} from '../../../lib/network-request.js';
import DevtoolsLog from '../devtools-log.js';
import {fetchResponseBodyFromCache} from '../../driver/network.js';
import {NetworkRecords} from '../../../computed/network-records.js';

const CHROME_EXTENSION_PROTOCOL = 'chrome-extension:';
const compressionHeaders = [
  'content-encoding',
  'x-original-content-encoding',
  'x-content-encoding-over-network',
];
const compressionTypes = ['gzip', 'br', 'deflate'];
const binaryMimeTypes = ['image', 'audio', 'video'];
/** @type {LH.Crdp.Network.ResourceType[]} */
const textResourceTypes = [
  NetworkRequest.TYPES.Document,
  NetworkRequest.TYPES.Script,
  NetworkRequest.TYPES.Stylesheet,
  NetworkRequest.TYPES.XHR,
  NetworkRequest.TYPES.Fetch,
  NetworkRequest.TYPES.EventSource,
];

class ResponseCompression extends BaseGatherer {
  /** @type {LH.Gatherer.GathererMeta<'DevtoolsLog'>} */
  meta = {
    supportedModes: ['timespan', 'navigation'],
    dependencies: {DevtoolsLog: DevtoolsLog.symbol},
  };

  /**
   * @param {LH.Artifacts.NetworkRequest[]} networkRecords
   * @return {LH.Artifacts['ResponseCompression']}
   */
  static filterUnoptimizedResponses(networkRecords) {
    /** @type {LH.Artifacts['ResponseCompression']} */
    const unoptimizedResponses = [];

    networkRecords.forEach(record => {
      if (record.isOutOfProcessIframe) return;

      const mimeType = record.mimeType;
      const resourceType = record.resourceType || NetworkRequest.TYPES.Other;
      const resourceSize = record.resourceSize;

      const isBinaryResource = mimeType && binaryMimeTypes.some(type => mimeType.startsWith(type));
      const isTextResource = !isBinaryResource && textResourceTypes.includes(resourceType);
      const isChromeExtensionResource = record.url.startsWith(CHROME_EXTENSION_PROTOCOL);

      if (!isTextResource || !resourceSize || !record.finished ||
        isChromeExtensionResource || !record.transferSize || record.statusCode === 304) {
        return;
      }

      const isContentEncoded = (record.responseHeaders || []).find(header =>
        compressionHeaders.includes(header.name.toLowerCase()) &&
        compressionTypes.includes(header.value)
      );

      if (!isContentEncoded) {
        unoptimizedResponses.push({
          requestId: record.requestId,
          url: record.url,
          mimeType: mimeType,
          transferSize: record.transferSize,
          resourceSize: resourceSize,
          gzipSize: 0,
        });
      }
    });

    return unoptimizedResponses;
  }

  /**
   * @param {LH.Gatherer.Context} context
   * @param {LH.Artifacts.NetworkRequest[]} networkRecords
   * @return {Promise<LH.Artifacts['ResponseCompression']>}
   */
  async getCompressibleRecords(context, networkRecords) {
    const session = context.driver.defaultSession;
    const textRecords = ResponseCompression.filterUnoptimizedResponses(networkRecords);

    return Promise.all(textRecords.map(record => {
      return fetchResponseBodyFromCache(session, record.requestId).then(content => {
        // if we don't have any content, gzipSize is already set to 0
        if (!content) {
          return record;
        }

        return new Promise((resolve, reject) => {
          return gzip(content, (err, res) => {
            if (err) {
              return reject(err);
            }

            // get gzip size
            record.gzipSize = Buffer.byteLength(res, 'utf8');

            resolve(record);
          });
        });
      }).catch(err => {
        Sentry.captureException(err, {
          tags: {gatherer: 'ResponseCompression'},
          extra: {url: UrlUtils.elideDataURI(record.url)},
          level: 'warning',
        });

        record.gzipSize = undefined;
        return record;
      });
    }));
  }

  /**
   * @param {LH.Gatherer.Context<'DevtoolsLog'>} context
   * @return {Promise<LH.Artifacts['ResponseCompression']>}
   */
  async getArtifact(context) {
    const devtoolsLog = context.dependencies.DevtoolsLog;
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    return this.getCompressibleRecords(context, networkRecords);
  }
}

export default ResponseCompression;
