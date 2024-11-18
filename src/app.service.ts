import { Injectable, OnModuleInit } from '@nestjs/common';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';
import { catchError, lastValueFrom, map, single, timeout } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

export enum EModeAirConditioning {
  AUTO = 1,
  COOL = 2,
  DRY = 3,
  FAN = 4,
  HEAT = 5,
}
// 0 cool, 1 heat, 2 auto, 3 fan, 4 dry
export enum ESpeedAirConditioning {
  AUTO = 1,
  LOW = 2,
  MIDDLE = 3,
  HIGH = 4,
} // + 1

// Mapping mode function
const mapMode = (mode: number): EModeAirConditioning | null => {
  switch (mode) {
    case 0:
      return EModeAirConditioning.COOL;
    case 1:
      return EModeAirConditioning.HEAT;
    case 2:
      return EModeAirConditioning.AUTO;
    case 3:
      return EModeAirConditioning.FAN;
    case 4:
      return EModeAirConditioning.DRY;
    default:
      return null;
  }
};

@Injectable()
export class AppService implements OnModuleInit {
  private tuya: TuyaContext;
  private baseUrlYoohome: string;

  constructor(
    private readonly httpService: HttpService,
    private configService: ConfigService,
  ) {
    const baseUrlTuya = this.configService.get<string>('TUYA_BASE_URL');
    this.baseUrlYoohome = this.configService.get<string>('YOOHOME_BASE_URL');
    const item = {
      accessKey: '5dggxggdmf3sjv5d5srq',
      secretKey: '26af427f8094466bb1594b82dd543d60',
    };
    this.tuya = new TuyaContext({
      baseUrl: baseUrlTuya,
      accessKey: item.accessKey,
      secretKey: item.secretKey,
    });
  }

  async onModuleInit() {
    // const devices = this.getAllDevice();
    // const devices2 = (await devices).filter((device: any) => {
    //   if (device.category !== 'qt') {
    //     return device;
    //   }
    // });
    // console.log(devices2);
    // await this.getAllBrand('eb25adf1cf1f0bcc7advbq', 5);
    const remoteIndex = (await this.getRemoteIndex(
      'eb25adf1cf1f0bcc7advbq',
      5,
      12,
    )) as {
      remote_index_list: [remote_index: number];
      total_count: number;
    };
    for (const remote of remoteIndex.remote_index_list as any[]) {
      const remoteKeys = await this.getRemoteKey(
        'eb25adf1cf1f0bcc7advbq',
        5,
        12,
        remote.remote_index,
      );
      console.log(remote.remote_index);
      for (const key of remoteKeys.data) {
        await this.sendStoreKey(
          'eb25adf1cf1f0bcc7advbq',
          5,
          remote.remote_index,
          key,
          remoteKeys.single_air,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    console.log('done');
  }

  async sendStoreKey(
    infrared_id: string,
    category_id: number,
    remoteIndex: number,
    remoteKey: any,
    single_air: boolean,
  ) {
    let input: { modeNumber: number; key: any };
    if (single_air) {
      input = {
        modeNumber: remoteIndex,
        key: remoteKey,
      };
    } else {
      const { key, ...rest } = remoteKey;
      input = {
        modeNumber: remoteIndex,
        key: rest,
      };
    }
    const url = `${this.baseUrlYoohome}/api/devices/storeKeyIRCode`;
    try {
      await lastValueFrom<{
        success: boolean;
      }>(
        this.httpService.post(url, input).pipe(
          map((res) => res.data),
          timeout(60000),
          catchError((error) => {
            throw error.response.data;
          }),
        ),
      );
    } catch (error) {
      throw new Error(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const response = await this.tuya.request({
      path: `/v2.0/infrareds/${infrared_id}/testing/raw/command`,
      method: 'POST',
      body: {
        remote_index: remoteIndex,
        category_id: category_id,
        key: remoteKey.key,
      },
    });
    if (!response.success) throw new Error(response.msg);
  }

  async getRemoteKey(
    infrared_id: string,
    category_id: number,
    brand_id: number,
    remote_index: number,
  ) {
    const response = await this.tuya.request({
      path: `/v2.0/infrareds/${infrared_id}/categories/${category_id}/brands/${brand_id}/remotes/${remote_index}/rules`,
      method: 'GET',
    });
    if (!response.success) throw new Error(response.msg);
    const data = response.result as [
      { code: string; key: string; key_id: number; key_name: string },
    ];
    const single_air = data.every((result) => {
      return !result.key.includes('power_on');
    });

    if (single_air) {
      const result = data.map((item) => {
        return {
          key: item.key,
          key_name: item.key_name,
        };
      });
      return { data: result, single_air: single_air };
    }
    const parsedResult = data.map((item) => {
      const { key } = item;
      const modeMatch = key.match(/M(\d+)/);
      const tempMatch = key.match(/T(\d+)/);
      const speedMatch = key.match(/S(\d+)/);

      const result: {
        key: string;
        mode?: number;
        temp?: number;
        speed?: number;
        power?: boolean;
      } = {
        key: key,
      };

      if (modeMatch) {
        const modeValue = Number(`${modeMatch[1]}`);
        result.mode = mapMode(modeValue);
      }
      if (tempMatch) {
        result.temp = Number(`${tempMatch[1]}`);
      }
      if (speedMatch) {
        result.speed = Number(`${speedMatch[1]}`) + 1;
      }
      if (key === 'power_on') {
        result.power = true;
      } else if (key === 'power_off') {
        result.power = false;
      }
      return result;
    });
    return { data: parsedResult, single_air: single_air };
  }

  async getRemoteIndex(
    infrared_id: string,
    category_id: number,
    brand_id: number,
  ) {
    const response = await this.tuya.request({
      path: `/v2.0/infrareds/${infrared_id}/categories/${category_id}/brands/${brand_id}/remote-indexs`,
      method: 'GET',
    });
    if (!response.success) throw new Error(response.msg);

    for (const remoteIndex of (
      response.result as { remote_index_list: any[]; total: number }
    ).remote_index_list) {
      const input = {
        brandId: brand_id,
        modeNumber: remoteIndex.remote_index as Number,
      };
      const url = `${this.baseUrlYoohome}/api/infrared/collection/remoteIndex`;
      try {
        await lastValueFrom<{
          success: boolean;
        }>(
          this.httpService.post(url, input).pipe(
            map((res) => res.data),
            timeout(60000),
            catchError((error) => {
              throw error.response.data;
            }),
          ),
        );
      } catch (error) {
        throw new Error(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return response.result;
  }

  async getAllBrand(infrared_id: string, category_id: number) {
    const response = await this.tuya.request({
      path: `/v2.0/infrareds/${infrared_id}/categories/${category_id}/brands`,
      method: 'GET',
    });
    if (!response.success) throw new Error(response.msg);

    for (const brand of response.result as any[]) {
      const input = {
        id: brand.brand_id,
        name: brand.brand_name,
      };

      const url = `${this.baseUrlYoohome}/api/infrared/collection/brand/AC`;
      try {
        await lastValueFrom<{
          success: boolean;
        }>(
          this.httpService.post(url, input).pipe(
            map((res) => res.data),
            timeout(60000),
            catchError((error) => {
              throw error.response.data;
            }),
          ),
        );
      } catch (error) {
        throw new Error(error);
      }
      // Add a delay of 0.1 seconds between each API call
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async getAllDevice() {
    let itemLength = 20;
    let device: any[] = [];
    let last_id = undefined;
    while (itemLength === 20) {
      const queryParams = `page_size=${itemLength}${last_id ? `&last_id=${last_id}` : ''}`;
      const response = await this.tuya.request({
        path: `/v2.0/cloud/thing/device?${queryParams}`,
        method: 'GET',
      });
      if (!response.success) throw new Error(response.msg);
      const devices = response.result as any[];
      device.push(...devices);
      itemLength = devices.length;
      if (itemLength === 20) {
        last_id = devices[devices.length - 1].id;
      }
    }
    return device;
  }
}
