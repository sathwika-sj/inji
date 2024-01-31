import {MMKVLoader} from 'react-native-mmkv-storage';
import getAllConfigurations from './commonprops/commonProps';
import {
  getFreeDiskStorageOldSync,
  getFreeDiskStorageSync,
} from 'react-native-device-info';
import SecureKeystore from '@mosip/secure-keystore';
import {
  decryptJson,
  encryptJson,
  HMAC_ALIAS,
  hmacSHA,
  isHardwareKeystoreExists,
} from './cryptoutil/cryptoUtil';
import {VCMetadata} from './VCMetadata';
import {ENOENT} from '../machines/store';
import {
  androidVersion,
  isAndroid,
  MY_VCS_STORE_KEY,
  SETTINGS_STORE_KEY,
} from './constants';
import FileStorage, {
  getFilePath,
  getDirectorySize,
  vcDirectoryPath,
} from './fileStorage';
import {__AppId} from './GlobalVariables';
import {getErrorEventData, sendErrorEvent} from './telemetry/TelemetryUtils';
import {TelemetryConstants} from './telemetry/TelemetryConstants';
import {BYTES_IN_MEGABYTE} from './commonUtil';

export const MMKV = new MMKVLoader().initialize();

export const API_CACHED_STORAGE_KEYS = {
  fetchIssuers: 'CACHE_FETCH_ISSUERS',
  fetchIssuerConfig: (issuerId: string) =>
    `CACHE_FETCH_ISSUER_CONFIG_${issuerId}`,
  fetchIssuerWellknownConfig: (issuerId: string) =>
    `CACHE_FETCH_ISSUER_WELLKNOWN_CONFIG_${issuerId}`,
};

async function generateHmac(
  encryptionKey: string,
  data: string,
): Promise<string> {
  if (!isHardwareKeystoreExists) {
    return hmacSHA(encryptionKey, data);
  }
  return await SecureKeystore.generateHmacSha(HMAC_ALIAS, data);
}

class Storage {
  static exportData = async (encryptionKey: string) => {
    const completeBackupData = {};
    const dataFromDB: Record<string, any> = {};

    const allKeysInDB = await MMKV.indexer.strings.getKeys();
    const keysToBeExported = allKeysInDB.filter(key =>
      key.includes('CACHE_FETCH_ISSUER_WELLKNOWN_CONFIG_'),
    );
    keysToBeExported.push(MY_VCS_STORE_KEY);

    const encryptedDataPromises = keysToBeExported.map(key =>
      MMKV.getItem(key),
    );

    Promise.all(encryptedDataPromises).then(encryptedDataList => {
      keysToBeExported.forEach(async (key, index) => {
        let encryptedData = encryptedDataList[index];
        if (encryptedData != null) {
          const decryptedData = await decryptJson(encryptionKey, encryptedData);
          dataFromDB[key] = JSON.parse(decryptedData);
        }
      });
    });

    completeBackupData['dataFromDB'] = dataFromDB;
    completeBackupData['VC_Records'] = {};

    let vcKeys = allKeysInDB.filter(key => key.indexOf('VC_') === 0);
    for (let ind in vcKeys) {
      const key = vcKeys[ind];
      const vc = await Storage.readVCFromFile(key);
      const decryptedVCData = await decryptJson(encryptionKey, vc);
      const deactivatedVC =
        removeWalletBindingDataBeforeBackup(decryptedVCData);
      completeBackupData['VC_Records'][key] = deactivatedVC;
    }
    return completeBackupData;
  };

  static loadBackupData = async (data, encryptionKey) => {
    try {
      // 1. opening the file
      const completeBackupData = JSON.parse(data);
      // 2. Load and store VC_records & MMKV things
      const dataFromDB = await Storage.loadVCs(
        completeBackupData,
        encryptionKey,
      );
      // 3. Update the Well Known configs of the VCs
      const allKeysFromDB = Object.keys(dataFromDB);
      const cacheKeys = allKeysFromDB.filter(key =>
        key.includes('CACHE_FETCH_ISSUER_WELLKNOWN_CONFIG_'),
      );
      cacheKeys.forEach(async key => {
        const value = dataFromDB[key];
        const encryptedValue = await encryptJson(
          encryptionKey,
          JSON.stringify(value),
        );
        await this.setItem(key, encryptedValue, encryptionKey);
        return true;
      });
    } catch (error) {
      return error;
    }
  };
  static isVCStorageInitialised = async (): Promise<boolean> => {
    try {
      const res = await FileStorage.getInfo(vcDirectoryPath);
      return res.isDirectory();
    } catch (_) {
      return false;
    }
  };

  static setItem = async (
    key: string,
    data: string,
    encryptionKey?: string,
  ) => {
    try {
      const isSavingVC = VCMetadata.isVCKey(key);
      if (isSavingVC) {
        await this.storeVC(key, data);
        return await this.storeVcHmac(encryptionKey, data, key);
      }

      await MMKV.setItem(key, data);
    } catch (error) {
      console.log('Error Occurred while saving in Storage.', error);
      throw error;
    }
  };

  static getItem = async (key: string, encryptionKey?: string) => {
    try {
      const isVCKey = VCMetadata.isVCKey(key);

      if (isVCKey) {
        const data = await this.readVCFromFile(key);
        const isCorrupted = await this.isCorruptedVC(key, encryptionKey, data);

        if (isCorrupted) {
          sendErrorEvent(
            getErrorEventData(
              TelemetryConstants.FlowType.fetchData,
              TelemetryConstants.ErrorId.tampered,
              'VC is corrupted and will be deleted from storage',
            ),
          );
          console.debug(
            '[Inji-406]: VC is corrupted and will be deleted from storage',
          );
          console.debug('[Inji-406]: VC key: ', key);
          console.debug('[Inji-406]: is Data null', data === null);
        }

        return isCorrupted ? null : data;
      }

      return await MMKV.getItem(key);
    } catch (error) {
      const isVCKey = VCMetadata.isVCKey(key);

      if (isVCKey) {
        const isDownloaded = await this.isVCAlreadyDownloaded(
          key,
          encryptionKey,
        );

        if (isDownloaded && error.message.includes(ENOENT)) {
          sendErrorEvent(
            getErrorEventData(
              TelemetryConstants.FlowType.fetchData,
              TelemetryConstants.ErrorId.dataRetrieval,
              error.message,
            ),
          );
          throw new Error(ENOENT);
        }
      }
      sendErrorEvent(
        getErrorEventData(
          TelemetryConstants.FlowType.fetchData,
          TelemetryConstants.ErrorId.dataRetrieval,
          'Error Occurred while retriving from Storage',
        ),
      );

      console.log('Error Occurred while retriving from Storage.', error);
      throw error;
    }
  };

  private static async loadVCs(completeBackupData: any, encryptionKey: any) {
    const allVCs = completeBackupData['VC_Records'];
    const allVCKeys = Object.keys(allVCs);
    allVCKeys.forEach(async key => {
      const vc = allVCs[key];
      const encryptedVC = await encryptJson(encryptionKey, JSON.stringify(vc));
      await this.setItem(key, encryptedVC, encryptionKey);
    });
    const dataFromDB = completeBackupData['dataFromDB'];

    const dataFromMyVCKey = dataFromDB[MY_VCS_STORE_KEY];
    const encryptedMyVCKeyFromMMKV = await MMKV.getItem(MY_VCS_STORE_KEY);
    let newDataForMyVCKey;
    if (encryptedMyVCKeyFromMMKV != null) {
      const myVCKeyFromMMKV = await decryptJson(
        encryptionKey,
        encryptedMyVCKeyFromMMKV,
      );
      newDataForMyVCKey = [...JSON.parse(myVCKeyFromMMKV), ...dataFromMyVCKey];
    } else {
      newDataForMyVCKey = dataFromMyVCKey;
    }
    const encryptedDataForMyVCKey = await encryptJson(
      encryptionKey,
      JSON.stringify(newDataForMyVCKey),
    );
    await this.setItem(
      MY_VCS_STORE_KEY,
      encryptedDataForMyVCKey,
      encryptionKey,
    );
    return dataFromDB;
  }

  private static async isVCAlreadyDownloaded(
    key: string,
    encryptionKey: string,
  ) {
    const storedHMACofCurrentVC = await this.readHmacForVC(key, encryptionKey);
    return storedHMACofCurrentVC !== null;
  }

  private static async isCorruptedVC(
    key: string,
    encryptionKey: string,
    data: string,
  ) {
    // TODO: INJI-612 refactor
    const storedHMACofCurrentVC = await this.readHmacForDataCorruptionCheck(
      key,
      encryptionKey,
    );
    const HMACofVC = await generateHmac(encryptionKey, data);
    return HMACofVC !== storedHMACofCurrentVC;
  }

  private static async readHmacForVC(key: string, encryptionKey: string) {
    const encryptedHMACofCurrentVC = await MMKV.getItem(key);
    if (encryptedHMACofCurrentVC) {
      return decryptJson(encryptionKey, encryptedHMACofCurrentVC);
    }
    return null;
  }

  private static async readHmacForDataCorruptionCheck(
    key: string,
    encryptionKey: string,
  ) {
    const encryptedHMACofCurrentVC = await MMKV.getItem(key);
    if (encryptedHMACofCurrentVC) {
      return decryptJson(encryptionKey, encryptedHMACofCurrentVC);
    }
    return null;
  }

  private static async readVCFromFile(key: string) {
    return await FileStorage.readFile(getFilePath(key));
  }

  private static async storeVC(key: string, data: string) {
    await FileStorage.createDirectory(vcDirectoryPath);
    const path = getFilePath(key);
    return await FileStorage.writeFile(path, data);
  }

  // TODO: INJI-612 refactor
  private static async storeVcHmac(
    encryptionKey: string,
    data: string,
    key: string,
  ) {
    const HMACofVC = await generateHmac(encryptionKey, data);
    const encryptedHMACofVC = await encryptJson(encryptionKey, HMACofVC);
    await MMKV.setItem(key, encryptedHMACofVC);
  }

  static removeItem = async (key: string) => {
    if (VCMetadata.isVCKey(key)) {
      const path = getFilePath(key);
      const isFileExists = await FileStorage.exists(path);
      if (isFileExists) {
        return await FileStorage.removeItem(path);
      } else {
        console.log('file not exist`s');
      }
    }
    MMKV.removeItem(key);
  };

  static clear = async () => {
    try {
      (await FileStorage.exists(`${vcDirectoryPath}`)) &&
        (await FileStorage.removeItem(`${vcDirectoryPath}`));
      const settings = await MMKV.getItem(SETTINGS_STORE_KEY);
      const appId = JSON.parse(settings).appId;
      __AppId.setValue(appId);
      MMKV.clearStore();
      await MMKV.setItem(SETTINGS_STORE_KEY, JSON.stringify({appId: appId}));
    } catch (e) {
      console.log('Error Occurred while Clearing Storage.', e);
    }
  };

  static isMinimumLimitReached = async (limitInMB: string) => {
    const configurations = await getAllConfigurations();
    if (!configurations[limitInMB]) return false;

    const minimumStorageLimitInBytes =
      configurations[limitInMB] * BYTES_IN_MEGABYTE;

    const freeDiskStorageInBytes =
      isAndroid() && androidVersion < 29
        ? getFreeDiskStorageOldSync()
        : getFreeDiskStorageSync();

    console.log('minimumStorageLimitInBytes ', minimumStorageLimitInBytes);
    console.log('freeDiskStorageInBytes ', freeDiskStorageInBytes);

    return freeDiskStorageInBytes <= minimumStorageLimitInBytes;
  };
}

export default Storage;

function removeWalletBindingDataBeforeBackup(data: string) {
  const vcData = JSON.parse(data);
  vcData.walletBindingResponse = null;
  vcData.publicKey = null;
  vcData.privateKey = null;
  return vcData;
}

export async function isMinimumLimitForBackupReached() {
  try {
    const directorySize = await getDirectorySize(vcDirectoryPath);
    const freeDiskStorageInBytes =
      isAndroid() && androidVersion < 29
        ? getFreeDiskStorageOldSync()
        : getFreeDiskStorageSync();

    return freeDiskStorageInBytes <= 2 * directorySize;
  } catch (error) {
    console.log('Error in isMinimumLimitForBackupReached:', error);
    throw error;
  }
}

export async function isMinimumLimitForBackupRestorationReached() {
  // TODO: Have two checks, one for downloading the ZIP file from the cloud &
  //  then by looking at it's metadata to check it's expanded size
  // APIs:
  // 1. CloudStorage.stat(file, context)
  // 2. getUncompressedSize()
  return await Storage.isMinimumLimitReached('minStorageRequired');
}
